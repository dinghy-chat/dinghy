// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { describe, expect, test } from "vitest";
import { uploadCutoff } from "./retention.ts";

describe("uploadCutoff", () => {
  test("goes back 12 months on an ordinary date", () => {
    expect(uploadCutoff(new Date("2027-06-15T08:30:00.000Z")).toISOString()).toBe(
      "2026-06-15T08:30:00.000Z",
    );
  });

  test("clamps a leap day to the last day of February", () => {
    expect(uploadCutoff(new Date("2028-02-29T12:34:56.789Z")).toISOString()).toBe(
      "2027-02-28T12:34:56.789Z",
    );
  });

  test("keeps the 31st when the target month has one", () => {
    expect(uploadCutoff(new Date("2027-03-31T23:59:59.000Z")).toISOString()).toBe(
      "2026-03-31T23:59:59.000Z",
    );
  });
});
