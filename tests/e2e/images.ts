import { deflateSync } from "node:zlib";
import type { Locator } from "@playwright/test";

/** A small valid PNG, built here so the tests need no image library or fixture file. */
function testPng(width = 16, height = 8): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngFile = (name = "screenshot.png") => ({
  name,
  mimeType: "image/png",
  buffer: testPng(),
});

/** Pastes an image into an element, as Ctrl+V does after taking a screenshot. */
export function pasteImage(target: Locator, text = "") {
  return target.evaluate(
    (element, [base64, plain]) => {
      const bytes = Uint8Array.from(atob(base64 ?? ""), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
      if (plain) data.setData("text/plain", plain);
      // A plain event, because Firefox ignores clipboardData in the ClipboardEvent constructor.
      const event = new Event("paste", { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      element.dispatchEvent(event);
    },
    [testPng().toString("base64"), text],
  );
}

/** Drops an image onto an element, as dragging a file from the desktop does. */
export function dropImage(target: Locator) {
  return target.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    for (const type of ["dragover", "drop"]) {
      element.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }
  }, testPng().toString("base64"));
}
