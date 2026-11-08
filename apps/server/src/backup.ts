import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";
import { extractTar, tarEnd, tarHeader, tarPadding } from "./archive.ts";

const MAGIC = Buffer.from("DINGHYBK1");
const CHUNK = 1024 * 1024;
const DEFAULT_KEEP = 7;
/** The largest single S3 upload, without multipart. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MANIFEST = "manifest.json";
const DUMP = "database.dump";
/** The app's secrets a backup holds. A restore stages only these names, whatever the archive holds. */
export const SECRET_FILES = [
  "auth_secret",
  "vapid_public_key",
  "vapid_private_key",
  "vapid_subject",
];

interface Manifest {
  format: 1;
  createdAt: string;
  lastMigration: string | null;
  storage: "local" | "s3";
}

const newKeyPair = () => generateKeyPairSync("x25519");

/** The raw 32 bytes of a key, as text a person can store. */
export function generateBackupKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = newKeyPair();
  return {
    publicKey: publicKey.export({ format: "jwk" }).x ?? "",
    privateKey: privateKey.export({ format: "jwk" }).d ?? "",
  };
}

const publicFrom = (x: string) =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
function privateFrom(d: string) {
  // JWK needs both halves, so this wraps the raw key in its standard DER form.
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const raw = Buffer.from(d, "base64url");
  if (raw.length !== 32) throw new Error("A private key has 32 bytes");
  return createPrivateKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "pkcs8" });
}

function deriveKey(shared: Buffer, salt: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.concat([MAGIC, ephemeral]), 32));
}

/** A nonce per chunk, with a last flag, so chunks cannot be reordered or the file cut short. */
function nonceFor(index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 3);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/**
 * Encrypts a file to a public key. Only the private key can open the result, and the server never
 * holds that, so the backup process encrypts with no secret on the server.
 */
export async function encryptFile(input: string, output: string, publicKey: string): Promise<void> {
  const ephemeral = newKeyPair();
  const ephemeralRaw = Buffer.from(
    ephemeral.publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  );
  const salt = randomBytes(32);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicFrom(publicKey),
  });
  const key = deriveKey(shared, salt, ephemeralRaw);
  const source = await open(input, "r");
  const target = await open(output, "wx", 0o600);
  try {
    await target.write(Buffer.concat([MAGIC, ephemeralRaw, salt]));
    let { size } = await source.stat();
    let index = 0;
    do {
      const piece = Buffer.alloc(Math.min(CHUNK, size));
      await source.read(piece, 0, piece.length);
      size -= piece.length;
      const cipher = createCipheriv("aes-256-gcm", key, nonceFor(index, size === 0));
      const sealed = Buffer.concat([cipher.update(piece), cipher.final(), cipher.getAuthTag()]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(sealed.length);
      await target.write(Buffer.concat([length, sealed]));
      index += 1;
    } while (size > 0);
  } finally {
    await source.close();
    await target.close();
  }
}

export class BackupKeyError extends Error {}

/** Opens a file from encryptFile. A wrong key, a change or a cut-off file all stop it. */
export async function decryptFile(
  input: string,
  output: string,
  privateKey: string,
): Promise<void> {
  const source = await open(input, "r");
  const target = await open(output, "wx", 0o600);
  try {
    const header = Buffer.alloc(MAGIC.length + 64);
    await source.read(header, 0, header.length);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupKeyError("This is not an encrypted Dinghy backup.");
    }
    const ephemeralRaw = header.subarray(MAGIC.length, MAGIC.length + 32);
    const salt = header.subarray(MAGIC.length + 32);
    let secret: ReturnType<typeof privateFrom>;
    try {
      secret = privateFrom(privateKey);
    } catch {
      throw new BackupKeyError("This private key is not valid.");
    }
    const shared = diffieHellman({
      privateKey: secret,
      publicKey: publicFrom(ephemeralRaw.toString("base64url")),
    });
    const key = deriveKey(shared, salt, Buffer.from(ephemeralRaw));
    let position = header.length;
    const { size } = await source.stat();
    let index = 0;
    while (position < size) {
      const lengthBytes = Buffer.alloc(4);
      await source.read(lengthBytes, 0, 4, position);
      const length = lengthBytes.readUInt32BE();
      if (length < 16 || length > CHUNK + 16 || position + 4 + length > size) {
        throw new BackupKeyError("This backup is damaged or cut off.");
      }
      const sealed = Buffer.alloc(length);
      await source.read(sealed, 0, length, position + 4);
      position += 4 + length;
      const decipher = createDecipheriv("aes-256-gcm", key, nonceFor(index, position === size));
      decipher.setAuthTag(sealed.subarray(-16));
      try {
        await target.write(
          Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]),
        );
      } catch {
        throw new BackupKeyError("This backup cannot be opened: a wrong key, or a damaged file.");
      }
      index += 1;
    }
    if (index === 0) throw new BackupKeyError("This backup is damaged or cut off.");
  } finally {
    await source.close();
    await target.close();
  }
}

export const isEncrypted = async (file: string) => {
  const handle = await open(file, "r");
  try {
    const start = Buffer.alloc(MAGIC.length);
    await handle.read(start, 0, start.length);
    return start.equals(MAGIC);
  } finally {
    await handle.close();
  }
};

async function listFiles(root: string, under = root): Promise<string[]> {
  const entries = await readdir(under, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(under, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

interface BackupOptions {
  /** Writes the database dump to this path. */
  dump(file: string): Promise<void>;
  directory: string;
  /** The app's secret directory, for what a restore needs that the database does not hold. */
  secretsDirectory: string | undefined;
  /** The local image directory, or undefined when images live in S3. */
  imagesDirectory: string | undefined;
  lastMigration: string | null;
  keep?: number;
  now?: Date;
  /** The free bytes in a directory. Tests replace it. */
  freeBytes?: (directory: string) => Promise<number>;
}

const diskFree = async (directory: string) => {
  const { bavail, bsize } = await statfs(directory);
  return bavail * bsize;
};

const megabytes = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

/**
 * A backup shares the disk with Postgres, which stops when the disk is full. So a backup needs twice
 * its size free, and refuses with a clear error instead of filling the disk.
 */
async function ensureSpace(
  directory: string,
  size: number,
  freeBytes: (directory: string) => Promise<number>,
): Promise<void> {
  const free = await freeBytes(directory);
  if (free >= size * 2) return;
  throw new Error(
    `Not enough free disk space for a backup: it needs about ${megabytes(size * 2)} and ${megabytes(free)} is free in ${directory}. Free some space or remove old backups there, then run it again. See docs/runbooks.md.`,
  );
}

/** The newest archive's size, the best guess of the next one's before the dump runs. */
async function lastBackupSize(directory: string): Promise<number> {
  const newest = (await readdir(directory))
    .filter((name) => /^dinghy-.*\.tar$/.test(name))
    .sort()
    .at(-1);
  return newest === undefined ? 0 : (await stat(join(directory, newest))).size;
}

/** Writes the whole archive through a partial name, so a failure leaves nothing that looks whole. */
export async function createBackup({
  dump,
  directory,
  secretsDirectory,
  imagesDirectory,
  lastMigration,
  keep = DEFAULT_KEEP,
  now = new Date(),
  freeBytes = diskFree,
}: BackupOptions): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureSpace(directory, await lastBackupSize(directory), freeBytes);
  const stamp = now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z");
  const file = join(directory, `dinghy-${stamp}-${randomBytes(4).toString("hex")}.tar`);
  const partial = `${file}.partial`;
  const work = await mkdtemp(join(directory, ".work-"));
  try {
    const dumpPath = join(work, DUMP);
    await dump(dumpPath);
    const manifest: Manifest = {
      format: 1,
      createdAt: now.toISOString(),
      lastMigration,
      storage: imagesDirectory === undefined ? "s3" : "local",
    };
    await writeFile(join(work, MANIFEST), JSON.stringify(manifest));
    const secretNames =
      secretsDirectory === undefined ? [] : await listFiles(secretsDirectory, secretsDirectory);
    const entries: { name: string; path: string }[] = [
      { name: MANIFEST, path: join(work, MANIFEST) },
      { name: DUMP, path: dumpPath },
      ...secretNames
        .filter((name) => SECRET_FILES.includes(name))
        .map((name) => ({ name: `secrets/${name}`, path: join(secretsDirectory ?? "", name) })),
      ...(imagesDirectory === undefined
        ? []
        : (await listFiles(imagesDirectory))
            // A temporary name is an upload still in progress, or a crash's leftover.
            .filter((name) => !/\.(tmp|partial)$/.test(name))
            .map((name) => ({ name: `images/${name}`, path: join(imagesDirectory, name) }))),
    ];
    // The dump is on the disk already, so this counts what the archive adds.
    let size = 0;
    for (const { path } of entries) size += (await stat(path).catch(() => null))?.size ?? 0;
    await ensureSpace(directory, size, freeBytes);
    const output = createWriteStream(partial, { mode: 0o600 });
    // A write's callback or finished() reports it. Without a listener, the process would exit at once.
    output.on("error", () => undefined);
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        output.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    try {
      for (const { name, path } of entries) {
        // An image deleted since the dump is not in the backup. An operator deleted it, so a restored
        // conversation can miss that image. The other order would lose images uploaded after the listing.
        const source = await open(path).catch((error: unknown) => {
          if ((error as { code?: unknown }).code === "ENOENT") return null;
          throw error;
        });
        if (source === null) continue;
        try {
          const { size } = await source.stat();
          await write(tarHeader(name, size));
          let written = 0;
          if (size > 0) {
            // Up to this size, because more bytes would misalign every entry after this one.
            const stream = source.createReadStream({ start: 0, end: size - 1, autoClose: false });
            for await (const part of stream) {
              await write(part as Uint8Array);
              written += (part as Uint8Array).length;
            }
          }
          if (written !== size) throw new Error(`${name} changed during the backup.`);
          await write(tarPadding(size));
        } finally {
          await source.close();
        }
      }
      await write(tarEnd());
    } finally {
      output.end();
      await finished(output);
    }
    await rename(partial, file);
    await pruneBackups(directory, keep);
    return file;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Keeps the newest ones. The names sort by time. */
async function pruneBackups(directory: string, keep: number): Promise<void> {
  const names = (await readdir(directory))
    .filter((name) => /^dinghy-.*\.tar$/.test(name))
    .sort()
    .reverse();
  for (const name of names.slice(keep)) await rm(join(directory, name), { force: true });
}

interface RemoteSettings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Encrypts the archive and uploads it, so the bucket never holds plaintext. */
export async function uploadBackup(
  file: string,
  publicKey: string,
  remote: RemoteSettings,
): Promise<string> {
  const sealed = `${file}.sealed`;
  await encryptFile(file, sealed, publicKey);
  try {
    const { size } = await stat(sealed);
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error("This backup is over the 5 GB limit of one upload.");
    }
    const name = `${file.split("/").at(-1)}.enc`;
    const client = new AwsClient({
      accessKeyId: remote.accessKeyId,
      secretAccessKey: remote.secretAccessKey,
      service: "s3",
      region: remote.region,
    });
    const url = `${remote.endpoint.replace(/\/$/, "")}/${remote.bucket}/${name}`;
    const signed = await client.sign(url, {
      method: "PUT",
      headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "content-length": String(size) },
    });
    const response = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: createReadStream(sealed) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit);
    if (!response.ok) throw new Error(`The backup bucket answered ${response.status}`);
    return name;
  } finally {
    await rm(sealed, { force: true });
  }
}

interface UnpackedBackup {
  manifest: Manifest;
  dumpPath: string;
  secretsPath: string;
  imagesPath: string;
}

/** Opens a backup, encrypted or not, into a working directory that the caller removes. */
export async function unpackBackup(
  file: string,
  work: string,
  privateKey: string | undefined,
): Promise<UnpackedBackup> {
  let archive = file;
  if (await isEncrypted(file)) {
    if (privateKey === undefined) {
      throw new BackupKeyError("This backup is encrypted. Set BACKUP_PRIVATE_KEY.");
    }
    archive = join(work, "archive.tar");
    await decryptFile(file, archive, privateKey);
  }
  const unpacked = join(work, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await extractTar(createReadStream(archive), unpacked);
  const manifest = JSON.parse(await readFile(join(unpacked, MANIFEST), "utf8")) as Manifest;
  if (manifest.format !== 1) throw new Error("This backup's format is newer than this release.");
  return {
    manifest,
    dumpPath: join(unpacked, DUMP),
    secretsPath: join(unpacked, "secrets"),
    imagesPath: join(unpacked, "images"),
  };
}

interface StagedFiles {
  count: number;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Copies unpacked files next to their targets, under new names. The risky part, such as a full disk,
 * happens here, and commit only renames. A secret is read-only, so a rename is also how it gets replaced.
 * With `only`, other names are skipped, so an archive cannot add a file such as `database_url`.
 */
export async function stageFiles(
  from: string,
  to: string,
  only?: readonly string[],
): Promise<StagedFiles> {
  const names = (await listFiles(from)).filter((name) => only === undefined || only.includes(name));
  const targets = names.map((name) => join(to, name));
  const abort = async () => {
    for (const target of targets) await rm(`${target}.partial`, { force: true });
  };
  try {
    for (const [index, target] of targets.entries()) {
      await mkdir(dirname(target), { recursive: true });
      await pipeline(
        createReadStream(join(from, names[index] ?? "")),
        createWriteStream(`${target}.partial`, { mode: 0o600 }),
      );
    }
  } catch (error) {
    await abort();
    throw error;
  }
  return {
    count: names.length,
    abort,
    async commit() {
      for (const target of targets) await rename(`${target}.partial`, target);
    },
  };
}
