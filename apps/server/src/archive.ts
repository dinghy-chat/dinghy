import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

// A small USTAR writer and reader, so an export is one file that standard tools can open too.

const BLOCK = 512;
/** Larger than any export's JSON or image should be, so a bad file cannot fill the memory. */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

/** USTAR holds 100 bytes of name and 155 of directory. A name that fits neither is an error, not a cut. */
function splitName(name: string): { prefix: string; rest: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", rest: name };
  for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1)) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, rest };
  }
  throw new Error(`This name is too long for an archive: ${name}`);
}

function field(block: Buffer, start: number, length: number): string {
  const part = block.subarray(start, start + length);
  const end = part.indexOf(0);
  return part.subarray(0, end === -1 ? length : end).toString("utf8");
}

function entryName(block: Buffer): string {
  const prefix = field(block, 345, 155);
  const rest = field(block, 0, 100);
  return prefix === "" ? rest : `${prefix}/${rest}`;
}

function header(name: string, size: number): Uint8Array {
  const block = Buffer.alloc(BLOCK);
  const { prefix, rest } = splitName(name);
  block.write(rest, 0, 100, "utf8");
  block.write(prefix, 345, 155, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\0" + "00", 257, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** One file in the archive, as the pieces to write in order. */
export function tarEntry(name: string, bytes: Uint8Array): Uint8Array[] {
  return tarEntryParts(name, [bytes]);
}

/** One file from several pieces, so a large file never has to sit in one buffer or one string. */
export function tarEntryParts(name: string, parts: Uint8Array[]): Uint8Array[] {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const padding = (BLOCK - (length % BLOCK)) % BLOCK;
  return [header(name, length), ...parts, new Uint8Array(padding)];
}

/** The end of an archive. A reader uses this to tell a whole file from a cut-off one. */
export const tarEnd = (): Uint8Array => new Uint8Array(BLOCK * 2);

export class BadArchiveError extends Error {}

/** Reads entries one at a time. It throws if the file is cut off or a header is damaged. */
export async function* readTar(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ name: string; bytes: Uint8Array }> {
  let pending = Buffer.alloc(0);
  const source = chunks[Symbol.asyncIterator]();
  const need = async (count: number): Promise<boolean> => {
    while (pending.length < count) {
      const next = await source.next();
      if (next.done) return false;
      pending = Buffer.concat([pending, next.value]);
    }
    return true;
  };
  for (;;) {
    if (!(await need(BLOCK))) throw new BadArchiveError("The archive is cut off.");
    const block = pending.subarray(0, BLOCK);
    if (block.every((byte) => byte === 0)) return;
    const stored = Number.parseInt(block.subarray(148, 156).toString("ascii").trim(), 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
      sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
    }
    if (sum !== stored) throw new BadArchiveError("An archive header is damaged.");
    const size = Number.parseInt(block.subarray(124, 136).toString("ascii").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
      throw new BadArchiveError("An archive entry has an impossible size.");
    }
    const name = entryName(block);
    const total = BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (!(await need(total))) throw new BadArchiveError("The archive is cut off.");
    yield { name, bytes: Uint8Array.from(pending.subarray(BLOCK, BLOCK + size)) };
    pending = pending.subarray(total);
  }
}

/** The bytes of a header, for a file whose contents arrive later as a stream. */
export const tarHeader = (name: string, size: number): Uint8Array => header(name, size);
export const tarPadding = (size: number): Uint8Array =>
  new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * Unpacks an archive to a directory piece by piece, because a database dump may not fit in memory.
 * It accepts only a plain relative name, so an entry cannot write outside the directory.
 */
export async function extractTar(
  chunks: AsyncIterable<Uint8Array>,
  directory: string,
): Promise<string[]> {
  const names: string[] = [];
  let pending = Buffer.alloc(0);
  let output: WriteStream | undefined;
  let remaining = 0;
  let skip = 0;
  let ended = false;
  const finishFile = async () => {
    const stream = output;
    output = undefined;
    if (stream !== undefined) {
      stream.end();
      await finished(stream);
    }
  };
  for await (const chunk of chunks) {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    while (!ended) {
      if (output !== undefined) {
        const piece = pending.subarray(0, remaining);
        if (output.errored) throw output.errored;
        // once() also rejects on an error, so a full disk cannot leave this waiting.
        if (piece.length > 0 && !output.write(piece)) await once(output, "drain");
        remaining -= piece.length;
        pending = pending.subarray(piece.length);
        if (remaining > 0) break;
        await finishFile();
        continue;
      }
      if (skip > 0) {
        const dropped = Math.min(skip, pending.length);
        skip -= dropped;
        pending = pending.subarray(dropped);
        if (skip > 0) break;
      }
      if (pending.length < BLOCK) break;
      const block = pending.subarray(0, BLOCK);
      if (block.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const stored = Number.parseInt(block.subarray(148, 156).toString("ascii").trim(), 8);
      let sum = 0;
      for (let index = 0; index < BLOCK; index++) {
        sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
      }
      if (sum !== stored) throw new BadArchiveError("An archive header is damaged.");
      const size = Number.parseInt(block.subarray(124, 136).toString("ascii").trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new BadArchiveError("An archive entry has an impossible size.");
      }
      const name = entryName(block);
      if (
        name === "" ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").some((part) => part === ".." || part === "." || part === "")
      ) {
        throw new BadArchiveError(`An archive entry has an unsafe name: ${name.slice(0, 100)}`);
      }
      pending = pending.subarray(BLOCK);
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true });
      names.push(name);
      output = createWriteStream(target, { mode: 0o600 });
      // The next write or finished() reports it. Without a listener, the process would exit at once,
      // and the caller could not remove what it unpacked.
      output.on("error", () => undefined);
      remaining = size;
      skip = (BLOCK - (size % BLOCK)) % BLOCK;
      if (size === 0) await finishFile();
    }
  }
  await finishFile();
  if (!ended) throw new BadArchiveError("The archive is cut off.");
  return names;
}
