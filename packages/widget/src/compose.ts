// The widget and the operator app send messages, images and files the same way, so they share this.

/** crypto.randomUUID exists only on secure pages, and a host site can be plain HTTP. */
export function newClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Safari ends the composition before this keydown, and then reports only keyCode 229. */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** The server's answers for an upload that no retry can fix. */
export const REFUSED = [400, 413, 507];
/** A broken image asks for new URLs at most this often, so one deleted file cannot cause a loop. */
export const REFRESH_LIMIT_MS = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** The other files people may send, by extension. The server checks their first bytes too. */
export const FILE_EXTENSIONS = [
  "pdf",
  "txt",
  "csv",
  "log",
  "json",
  "zip",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "mp4",
  "mov",
] as const;
export type FileExtension = (typeof FILE_EXTENSIONS)[number];

const isFileExtension = (value: string): value is FileExtension =>
  (FILE_EXTENSIONS as readonly string[]).includes(value);

/** A name's extension in lower case, when it is one that people may send. */
export function fileExtension(name: string): FileExtension | null {
  const dot = name.lastIndexOf(".");
  const extension = name.slice(dot + 1).toLowerCase();
  return dot > 0 && isFileExtension(extension) ? extension : null;
}

/** The file picker's `accept`: images, and the other files when this side may send them. */
export const acceptedFiles = (filesAllowed: boolean) =>
  [...IMAGE_TYPES, ...(filesAllowed ? FILE_EXTENSIONS.map((one) => `.${one}`) : [])].join(",");

export const isImage = (file: File) => IMAGE_TYPES.includes(file.type);

/** Why the server would refuse this file, as a text key both apps define, or null. */
export function uploadProblem(
  file: File,
  filesAllowed: boolean,
): "imageWrongType" | "imageTooLarge" | "fileWrongType" | "fileTooLarge" | null {
  if (isImage(file)) return file.size > MAX_IMAGE_BYTES ? "imageTooLarge" : null;
  if (!filesAllowed) return "imageWrongType";
  if (fileExtension(file.name) === null) return "fileWrongType";
  return file.size > MAX_FILE_BYTES ? "fileTooLarge" : null;
}

/** A file's size as both apps show it beside its name, such as 340 KB or 2.4 MB. */
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Adds a confirmed line in commit order. Pending lines have no seq yet, and stay last. Lines nearly
 * always arrive in order, so it looks for the place from the end, and a replay sorts nothing.
 */
export function inCommitOrder<L extends { seq: bigint | null }>(others: L[], line: L): L[] {
  const confirmed = others.filter((other) => other.seq !== null);
  const seq = line.seq ?? 0n;
  let at = confirmed.length;
  while (at > 0 && (confirmed[at - 1]?.seq ?? 0n) > seq) at -= 1;
  confirmed.splice(at, 0, line);
  return [...confirmed, ...others.filter((other) => other.seq === null)];
}
