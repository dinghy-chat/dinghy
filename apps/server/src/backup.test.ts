import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BadArchiveError, extractTar, readTar, tarEnd, tarEntry } from "./archive.ts";
import {
  BackupKeyError,
  createBackup,
  decryptFile,
  encryptFile,
  generateBackupKeys,
  isEncrypted,
  SECRET_FILES,
  stageFiles,
  unpackBackup,
} from "./backup.ts";

const newDirectory = () => mkdtemp(join(tmpdir(), "dinghy-backup-"));
const fakeDump =
  (contents = "the database") =>
  async (file: string) => {
    await writeFile(file, contents);
  };

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("the encrypted copy", () => {
  async function sealed(contents: Uint8Array) {
    const directory = await newDirectory();
    const input = join(directory, "plain");
    const output = join(directory, "sealed");
    await writeFile(input, contents);
    const keys = generateBackupKeys();
    await encryptFile(input, output, keys.publicKey);
    return { directory, output, keys };
  }

  test.each([
    ["empty", 0],
    ["small", 100],
    ["exactly one chunk", 1024 * 1024],
    ["several chunks", 3 * 1024 * 1024 + 17],
  ])("a %s file opens with the private key, byte for byte", async (_name, size) => {
    const contents = randomBytes(size);
    const { directory, output, keys } = await sealed(contents);
    const opened = join(directory, "opened");
    await decryptFile(output, opened, keys.privateKey);
    expect((await readFile(opened)).equals(contents)).toBe(true);
  });

  test("the result holds no plaintext, and two copies differ", async () => {
    const marker = Buffer.from("A VERY RECOGNIZABLE CHAT MESSAGE");
    const { output, keys, directory } = await sealed(marker);
    expect((await readFile(output)).includes(marker)).toBe(false);
    const second = join(directory, "second");
    await encryptFile(join(directory, "plain"), second, keys.publicKey);
    expect((await readFile(second)).equals(await readFile(output))).toBe(false);
    expect(await isEncrypted(output)).toBe(true);
    expect(await isEncrypted(join(directory, "plain"))).toBe(false);
  });

  test("the public key alone cannot open it, and neither can another key", async () => {
    const { output, directory, keys } = await sealed(Buffer.from("secret"));
    await expect(
      decryptFile(output, join(directory, "a"), generateBackupKeys().privateKey),
    ).rejects.toBeInstanceOf(BackupKeyError);
    await expect(decryptFile(output, join(directory, "b"), keys.publicKey)).rejects.toBeInstanceOf(
      BackupKeyError,
    );
    await expect(decryptFile(output, join(directory, "c"), "nonsense")).rejects.toBeInstanceOf(
      BackupKeyError,
    );
  });

  test("a changed byte stops it", async () => {
    const { output, directory, keys } = await sealed(randomBytes(5000));
    const bytes = await readFile(output);
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 1;
    await writeFile(output, bytes);
    await expect(decryptFile(output, join(directory, "o"), keys.privateKey)).rejects.toBeInstanceOf(
      BackupKeyError,
    );
  });

  test("a copy cut off at a chunk's end stops it, so nothing can drop the tail", async () => {
    const { output, directory, keys } = await sealed(randomBytes(2 * 1024 * 1024 + 5));
    const bytes = await readFile(output);
    const headerLength = 9 + 64;
    const firstLength = bytes.readUInt32BE(headerLength);
    await writeFile(output, bytes.subarray(0, headerLength + 4 + firstLength));
    await expect(decryptFile(output, join(directory, "o"), keys.privateKey)).rejects.toBeInstanceOf(
      BackupKeyError,
    );
  });

  test("swapped chunks stop it", async () => {
    // Three chunks, so that neither of the two swapped ones is the last, and only the index differs.
    const { output, directory, keys } = await sealed(randomBytes(3 * 1024 * 1024));
    const bytes = await readFile(output);
    const headerLength = 9 + 64;
    const size = 4 + bytes.readUInt32BE(headerLength);
    const swapped = Buffer.concat([
      bytes.subarray(0, headerLength),
      bytes.subarray(headerLength + size, headerLength + 2 * size),
      bytes.subarray(headerLength, headerLength + size),
      bytes.subarray(headerLength + 2 * size),
    ]);
    await writeFile(output, swapped);
    await expect(decryptFile(output, join(directory, "o"), keys.privateKey)).rejects.toBeInstanceOf(
      BackupKeyError,
    );
  });

  test("the file is private", async () => {
    const { output } = await sealed(Buffer.from("x"));
    expect((await stat(output)).mode & 0o077).toBe(0);
  });
});

describe("the archive", () => {
  async function world() {
    const root = await newDirectory();
    const secrets = join(root, "secrets");
    const images = join(root, "images");
    await mkdir(secrets);
    await mkdir(join(images, "workspace-a"), { recursive: true });
    await writeFile(join(secrets, "auth_secret"), "the auth secret");
    await writeFile(join(secrets, "vapid_private_key"), "the push key");
    await writeFile(join(secrets, "database_url"), "postgres://dinghy_app:password@db/dinghy");
    await writeFile(join(images, "workspace-a", "one.png"), "an image");
    return { root, secrets, images, directory: join(root, "backups") };
  }

  test("it holds the database, images and the app's secrets, and no database password", async () => {
    const { root, secrets, images, directory } = await world();
    const file = await createBackup({
      dump: fakeDump(),
      directory,
      secretsDirectory: secrets,
      imagesDirectory: images,
      lastMigration: "0016_x",
    });
    expect((await stat(file)).mode & 0o077).toBe(0);
    const work = join(root, "work");
    await mkdir(work);
    const unpacked = await unpackBackup(file, work, undefined);
    expect(unpacked.manifest.storage).toBe("local");
    expect(unpacked.manifest.lastMigration).toBe("0016_x");
    expect(await readFile(unpacked.dumpPath, "utf8")).toBe("the database");
    expect(await readFile(join(unpacked.imagesPath, "workspace-a", "one.png"), "utf8")).toBe(
      "an image",
    );
    expect(await readFile(join(unpacked.secretsPath, "auth_secret"), "utf8")).toBe(
      "the auth secret",
    );
    // This server's own logins stay on this server.
    expect((await readdir(unpacked.secretsPath)).sort()).toEqual([
      "auth_secret",
      "vapid_private_key",
    ]);
  });

  test("with images in a bucket, it says so and holds none", async () => {
    const { root, secrets, directory } = await world();
    const file = await createBackup({
      dump: fakeDump(),
      directory,
      secretsDirectory: secrets,
      imagesDirectory: undefined,
      lastMigration: null,
    });
    const work = join(root, "work");
    await mkdir(work);
    const unpacked = await unpackBackup(file, work, undefined);
    expect(unpacked.manifest.storage).toBe("s3");
    await expect(readdir(unpacked.imagesPath)).rejects.toThrow();
  });

  test("a failed dump leaves nothing that looks like a backup, or any working files", async () => {
    const { secrets, images, directory } = await world();
    await expect(
      createBackup({
        dump: async () => {
          throw new Error("pg_dump failed");
        },
        directory,
        secretsDirectory: secrets,
        imagesDirectory: images,
        lastMigration: null,
      }),
    ).rejects.toThrow("pg_dump failed");
    expect(await readdir(directory)).toEqual([]);
  });

  test("too little free disk space stops it with a clear message, and leaves nothing", async () => {
    const { secrets, images, directory } = await world();
    await expect(
      createBackup({
        dump: fakeDump("x".repeat(1000)),
        directory,
        secretsDirectory: secrets,
        imagesDirectory: images,
        lastMigration: null,
        freeBytes: async () => 1500,
      }),
    ).rejects.toThrow(/Not enough free disk space for a backup: it needs about/);
    expect(await readdir(directory)).toEqual([]);
  });

  test("with a previous backup that would not fit twice, it stops before the dump", async () => {
    const { secrets, images, directory } = await world();
    const options = { directory, secretsDirectory: secrets, imagesDirectory: images };
    await createBackup({ ...options, dump: fakeDump(), lastMigration: null });
    let dumped = false;
    await expect(
      createBackup({
        ...options,
        dump: async (file) => {
          dumped = true;
          await writeFile(file, "the database");
        },
        lastMigration: null,
        freeBytes: async () => 10,
      }),
    ).rejects.toThrow(/Not enough free disk space/);
    expect(dumped).toBe(false);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tar"))).toHaveLength(1);
  });

  test("a file it cannot read while it writes the archive leaves nothing either", async () => {
    const { secrets, images, directory } = await world();
    await chmod(join(secrets, "auth_secret"), 0);
    await expect(
      createBackup({
        dump: async (path) => writeFile(path, "dump"),
        directory,
        secretsDirectory: secrets,
        imagesDirectory: images,
        lastMigration: null,
      }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  test("an image with a long name comes back under that name, and an upload in progress stays out", async () => {
    const { root, secrets, images, directory } = await world();
    // The shape of an imported image's key, which is longer than a tar name field.
    const uuid = "00000000-0000-4000-8000-000000000000";
    const key = `${uuid}/${uuid}-${uuid}`;
    await mkdir(join(images, uuid));
    await writeFile(join(images, key), "the long one");
    await writeFile(join(images, `${key}.123.tmp`), "half an upload");
    const file = await createBackup({
      dump: fakeDump(),
      directory,
      secretsDirectory: secrets,
      imagesDirectory: images,
      lastMigration: null,
    });
    const work = join(root, "work");
    await mkdir(work);
    const unpacked = await unpackBackup(file, work, undefined);
    expect(await readFile(join(unpacked.imagesPath, key), "utf8")).toBe("the long one");
    expect(await readdir(join(unpacked.imagesPath, uuid))).toEqual([`${uuid}-${uuid}`]);
  });

  test("two backups in the same second get their own files", async () => {
    const { secrets, images, directory } = await world();
    const now = new Date();
    const options = {
      dump: fakeDump(),
      directory,
      secretsDirectory: secrets,
      imagesDirectory: images,
      lastMigration: null,
      now,
    };
    const made = await Promise.all([createBackup(options), createBackup(options)]);
    expect(new Set(made).size).toBe(2);
  });

  test("it keeps the newest ones, and deletes the rest", async () => {
    const { secrets, images, directory } = await world();
    const stamps = [1, 2, 3, 4].map((day) => new Date(Date.UTC(2030, 0, day)));
    const made: string[] = [];
    for (const now of stamps) {
      made.push(
        await createBackup({
          dump: fakeDump(),
          directory,
          secretsDirectory: secrets,
          imagesDirectory: images,
          lastMigration: null,
          keep: 2,
          now,
        }),
      );
    }
    expect((await readdir(directory)).sort()).toEqual(
      made
        .slice(2)
        .map((file) => file.split("/").at(-1))
        .sort(),
    );
  });

  test("an encrypted backup needs its key, and opens with it", async () => {
    const { root, secrets, images, directory } = await world();
    const file = await createBackup({
      dump: fakeDump(),
      directory,
      secretsDirectory: secrets,
      imagesDirectory: images,
      lastMigration: null,
    });
    const keys = generateBackupKeys();
    const sealed = `${file}.sealed`;
    await encryptFile(file, sealed, keys.publicKey);
    const first = join(root, "first");
    await mkdir(first);
    await expect(unpackBackup(sealed, first, undefined)).rejects.toThrow("BACKUP_PRIVATE_KEY");
    const second = join(root, "second");
    await mkdir(second);
    const unpacked = await unpackBackup(sealed, second, keys.privateKey);
    expect(await readFile(unpacked.dumpPath, "utf8")).toBe("the database");
  });
});

test("restoring files replaces a read-only secret, and leaves no partial file", async () => {
  const from = await newDirectory();
  const to = await newDirectory();
  await writeFile(join(from, "auth_secret"), "from the backup");
  await writeFile(join(to, "auth_secret"), "from this host", { mode: 0o400 });
  await writeFile(join(to, "database_url"), "this host's own login");
  const staged = await stageFiles(from, to);
  expect(staged.count).toBe(1);
  await staged.commit();
  expect(await readFile(join(to, "auth_secret"), "utf8")).toBe("from the backup");
  expect(await readFile(join(to, "database_url"), "utf8")).toBe("this host's own login");
  expect((await readdir(to)).sort()).toEqual(["auth_secret", "database_url"]);
  expect((await stat(join(to, "auth_secret"))).mode & 0o077).toBe(0);
});

test("a restore stages only the secrets a backup writes", async () => {
  const from = await newDirectory();
  const to = await newDirectory();
  await writeFile(join(from, "auth_secret"), "from the backup");
  await writeFile(join(from, "database_url"), "postgres://attacker@203.0.113.1/db");
  await writeFile(join(from, "stripe_secret_key"), "sk_attacker");
  await writeFile(join(to, "database_url"), "this host's own login");
  const staged = await stageFiles(from, to, SECRET_FILES);
  expect(staged.count).toBe(1);
  await staged.commit();
  expect(await readFile(join(to, "auth_secret"), "utf8")).toBe("from the backup");
  expect(await readFile(join(to, "database_url"), "utf8")).toBe("this host's own login");
  expect((await readdir(to)).sort()).toEqual(["auth_secret", "database_url"]);
});

test("staged secrets stay out of place until the commit, and an abort removes them", async () => {
  const root = await newDirectory();
  const from = join(root, "from");
  const to = join(root, "to");
  await mkdir(from);
  await mkdir(to);
  await writeFile(join(from, "auth_secret"), "from the backup");
  await writeFile(join(to, "auth_secret"), "this server's");

  const aborted = await stageFiles(from, to);
  expect(await readFile(join(to, "auth_secret"), "utf8")).toBe("this server's");
  await aborted.abort();
  expect(await readdir(to)).toEqual(["auth_secret"]);
  expect(await readFile(join(to, "auth_secret"), "utf8")).toBe("this server's");

  const kept = await stageFiles(from, to);
  await kept.commit();
  expect(await readdir(to)).toEqual(["auth_secret"]);
  expect(await readFile(join(to, "auth_secret"), "utf8")).toBe("from the backup");
});

describe("names in an archive", () => {
  const long = `${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(80)}`;

  test("a long name survives both readers", async () => {
    const bytes = Buffer.concat([...tarEntry(long, Buffer.from("x")), tarEnd()]);
    const read: string[] = [];
    for await (const entry of readTar(once(bytes))) read.push(entry.name);
    expect(read).toEqual([long]);
    await expect(extractTar(once(bytes), await newDirectory())).resolves.toEqual([long]);
  });

  test("a name that cannot fit is an error, not a cut", () => {
    expect(() => tarEntry("x".repeat(101), Buffer.from("x"))).toThrow("too long");
  });
});

describe("unpacking", () => {
  // Only Linux has this device.
  test.runIf(existsSync("/dev/full"))("a full disk is an error the caller can handle", async () => {
    const directory = await newDirectory();
    await symlink("/dev/full", join(directory, "file"));
    const bytes = Buffer.concat([...tarEntry("file", randomBytes(4096)), tarEnd()]);
    // A pause between the pieces, so the error arrives while nothing is waiting on the stream.
    async function* slowly() {
      yield bytes.subarray(0, 1024);
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield bytes.subarray(1024);
    }
    await expect(extractTar(slowly(), directory)).rejects.toThrow("ENOSPC");
  });

  const archiveWith = (...names: string[]) =>
    Buffer.concat([
      ...names.flatMap((name) => tarEntry(name, Buffer.from(`contents of ${name}`))),
      tarEnd(),
    ]);

  test("it writes each file, including an empty one and one larger than a chunk", async () => {
    const directory = await newDirectory();
    const big = randomBytes(300_000);
    const bytes = Buffer.concat([
      ...tarEntry("a/empty", Buffer.alloc(0)),
      ...tarEntry("a/b/big", big),
      ...tarEntry("small", Buffer.from("x")),
      tarEnd(),
    ]);
    // Small pieces, so an entry and a header can fall across a read.
    async function* pieces() {
      for (let index = 0; index < bytes.length; index += 7000) {
        yield bytes.subarray(index, index + 7000);
      }
    }
    const names = await extractTar(pieces(), directory);
    expect(names).toEqual(["a/empty", "a/b/big", "small"]);
    expect((await readFile(join(directory, "a/empty"))).length).toBe(0);
    expect((await readFile(join(directory, "a/b/big"))).equals(big)).toBe(true);
    expect(await readFile(join(directory, "small"), "utf8")).toBe("x");
  });

  test.each(["../escape", "a/../../escape", "/etc/passwd", "a//b", "./a", "a\\\\b"])(
    "a name like %s is refused",
    async (name) => {
      const directory = await newDirectory();
      await expect(extractTar(once(archiveWith(name)), directory)).rejects.toBeInstanceOf(
        BadArchiveError,
      );
    },
  );

  test("a file cut off anywhere is refused", async () => {
    const whole = archiveWith("a");
    for (const size of [100, 512, 600, whole.length - 1024]) {
      await expect(
        extractTar(once(whole.subarray(0, size)), await newDirectory()),
      ).rejects.toBeInstanceOf(BadArchiveError);
    }
  });

  test("a damaged header is refused", async () => {
    const whole = Buffer.from(archiveWith("a"));
    whole[3] = 0x58;
    await expect(extractTar(once(whole), await newDirectory())).rejects.toThrow("damaged");
  });

  test("a real file reads through the same path", async () => {
    const directory = await newDirectory();
    const file = join(directory, "a.tar");
    await writeFile(file, archiveWith("hello"));
    const out = join(directory, "out");
    await mkdir(out);
    expect(await extractTar(createReadStream(file), out)).toEqual(["hello"]);
  });
});
