// The widget and the operator app send messages and images the same way, so they share this.

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

/** The server's answers for an image that no retry can fix. */
export const REFUSED = [400, 413, 507];
/** A broken image asks for new URLs at most this often, so one deleted file cannot cause a loop. */
export const REFRESH_LIMIT_MS = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Why the server would refuse this file, as a text key both apps define, or null. */
export function imageProblem(file: File): "imageWrongType" | "imageTooLarge" | null {
  if (!IMAGE_TYPES.includes(file.type)) return "imageWrongType";
  if (file.size > MAX_IMAGE_BYTES) return "imageTooLarge";
  return null;
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
