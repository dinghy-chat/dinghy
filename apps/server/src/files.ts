import {
  FILE_EXTENSIONS,
  type FileExtension,
  fileExtension,
} from "../../../packages/widget/src/compose.ts";

/** The types people may send besides images, for the API's words: "PDF, TXT, …, MOV". */
export const FILE_TYPES_TEXT = FILE_EXTENSIONS.map((one) => one.toUpperCase()).join(", ");

/** Every file goes out as a download, so its type never matters to a browser. */
export const FILE_TYPE = "application/octet-stream";

/** The longest name an upload or an import may give, in characters, before it is cleaned and cut. */
export const FILENAME_INPUT_MAX = 1000;

/** The longest name a file keeps, in characters, with its extension. */
const NAME_MAX = 100;
// Letters and digits in any script, and a few marks. Anything else, such as a slash, a quote or a
// control character, becomes "_".
const UNSAFE = /[^\p{L}\p{N} ._()-]+/gu;

export const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, i) => bytes[at + i] === byte);

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

interface Signature {
  at: number;
  bytes: number[];
}
// A ZIP starts with its first entry, or with its end record when it is empty, or with the mark of
// an archive split into parts.
const ZIP = [
  { at: 0, bytes: ascii("PK\x03\x04") },
  { at: 0, bytes: ascii("PK\x05\x06") },
  { at: 0, bytes: ascii("PK\x07\x08") },
];
// The Office formats from before 2007 are OLE compound files.
const OLE = [{ at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }];
const MP4 = [{ at: 4, bytes: ascii("ftyp") }];
// An older QuickTime movie starts with any of its top-level atoms, not always `ftyp`.
const QUICKTIME = ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].map((atom) => ({
  at: 4,
  bytes: ascii(atom),
}));

/**
 * What a file's first bytes may be, by extension. Text has none to check, and every file is served
 * as a download all the same.
 */
const SIGNATURES: Record<FileExtension, Signature[] | null> = {
  pdf: [{ at: 0, bytes: ascii("%PDF-") }],
  txt: null,
  csv: null,
  log: null,
  json: null,
  zip: ZIP,
  docx: ZIP,
  xlsx: ZIP,
  pptx: ZIP,
  odt: ZIP,
  ods: ZIP,
  doc: OLE,
  xls: OLE,
  ppt: OLE,
  mp4: MP4,
  mov: QUICKTIME,
};

/** The bytes start as one of the type's signatures, or the type has none to check. */
const hasSignature = (bytes: Uint8Array, signatures: Signature[] | null) =>
  signatures === null || signatures.some(({ at, bytes: start }) => startsWith(bytes, start, at));

/**
 * The file's name, cleaned and cut to 100 characters with its extension kept, or null when its
 * extension is not one people may send or its first bytes do not match it.
 */
export function allowedFileName(name: string, bytes: Uint8Array): string | null {
  const clean = name
    .normalize("NFC")
    .replace(UNSAFE, "_")
    .replace(/^[ .]+|[ .]+$/g, "");
  const extension = fileExtension(clean);
  if (extension === null) return null;
  if (!hasSignature(bytes, SIGNATURES[extension])) return null;
  const base = Array.from(clean.slice(0, clean.lastIndexOf(".")))
    .slice(0, NAME_MAX - extension.length - 1)
    .join("");
  return `${base}.${extension}`;
}

/** RFC 5987 leaves these out of a parameter's value, and encodeURIComponent keeps them. */
const encodeParameter = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Content-Disposition for a download under the file's cleaned name. The plain `filename` is for
 * old clients, with "_" in place of anything outside ASCII, and RFC 6266's `filename*` has it all.
 */
export const downloadDisposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeParameter(name)}`;
