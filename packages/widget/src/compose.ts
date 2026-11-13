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

/**
 * What to tell about an upload the server refused, by its error code, as a text key both apps
 * define. A full workspace is the caller's own text.
 */
export function refusalProblem(code: string | null, file: File) {
  if (code === "too_large") return isImage(file) ? "imageTooLarge" : "fileTooLarge";
  // The browser called it an image, and the server could not read it as one.
  if (isImage(file)) return "imageFailed";
  if (code === "type_not_allowed") return "fileWrongType";
  // The widget's files were turned off after it loaded.
  if (code === "not_an_image") return "imageWrongType";
  return "imageFailed";
}

/** A file's size as both apps show it beside its name, such as 340 kB or 2.4 MB, or 2,4 Mo in French. */
export function fileSize(bytes: number, locale: Intl.LocalesArgument): string {
  const kilobytes = bytes / 1024;
  const isSmall = kilobytes < 1024;
  const digits = isSmall ? 0 : 1;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: isSmall ? "kilobyte" : "megabyte",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(isSmall ? Math.max(1, kilobytes) : kilobytes / 1024);
}

/**
 * Saves a file through a blob URL, and answers the server's status. A link cannot do it: a browser
 * ignores `download` on a link to another origin and opens the address instead, and an old address
 * is gone.
 */
async function saveFile(url: string, name: string): Promise<number> {
  const response = await fetch(url);
  if (response.ok) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href));
  }
  return response.status;
}

/**
 * A click on a file's link. A URL lives 15 minutes, so when the server says this one expired, it
 * asks once for a new one and saves with it. The device's clock does not decide, as it can be
 * wrong. Any other failure ends the click, and the visitor or operator can click again.
 */
export async function saveWithRefresh(
  url: string,
  name: string,
  newUrl: () => Promise<string>,
): Promise<void> {
  try {
    if ((await saveFile(url, name)) === 404) await saveFile(await newUrl(), name);
  } catch {
    // The network failed. Nothing to tell: the link stays, and another click tries again.
  }
}

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
