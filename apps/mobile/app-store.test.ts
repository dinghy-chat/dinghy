import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ageRatingAnswers,
  fieldStatus,
  isEditable,
  jwtClaims,
  md5,
  parseArgs,
  pngSize,
  screenshotPlan,
  signToken,
  submissionStep,
} from "./scripts/app-store-logic.ts";

describe("the API token", () => {
  test("lasts 20 minutes for App Store Connect", () => {
    expect(jwtClaims("issuer", 1_000)).toEqual({
      iss: "issuer",
      iat: 1_000,
      exp: 2_200,
      aud: "appstoreconnect-v1",
    });
  });

  test("carries a raw ES256 signature that the public key verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const [header = "", claims = "", signature = ""] = signToken("KEY", "issuer", pem, 5_000).split(
      ".",
    );
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString()).iat).toBe(5);
    const raw = Buffer.from(signature, "base64url");
    expect(raw).toHaveLength(64);
    const isValid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      raw,
    );
    expect(isValid).toBe(true);
  });
});

test("md5 matches Apple's sourceFileChecksum format", () => {
  expect(md5(Buffer.from("dinghy"))).toMatch(/^[0-9a-f]{32}$/);
});

test("pngSize reads the IHDR chunk", () => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(header);
  header.writeUInt32BE(1320, 16);
  header.writeUInt32BE(2868, 20);
  expect(pngSize(header)).toEqual({ width: 1320, height: 2868 });
  expect(() => pngSize(Buffer.alloc(24))).toThrow("Not a PNG");
});

test("only versions Apple lets us change are editable", () => {
  expect(isEditable("PREPARE_FOR_SUBMISSION")).toBe(true);
  expect(isEditable("METADATA_REJECTED")).toBe(true);
  expect(isEditable("READY_FOR_REVIEW")).toBe(true);
  expect(isEditable("WAITING_FOR_REVIEW")).toBe(false);
  expect(isEditable(undefined)).toBe(false);
});

test("fieldStatus tells missing from different", () => {
  expect(fieldStatus("a", "a")).toBe("ok");
  expect(fieldStatus("a", "b")).toBe("differs");
  expect(fieldStatus("a", null)).toBe("missing");
  expect(fieldStatus("a", "")).toBe("missing");
});

test("the age rating says no to everything but chat and user content", () => {
  const { answers, unknown } = ageRatingAnswers({
    violenceRealistic: null,
    profanityOrCrudeHumor: "FREQUENT_OR_INTENSE",
    gambling: null,
    lootBox: true,
    messagingAndChat: null,
    userGeneratedContent: false,
    kidsAgeBand: null,
    ageRatingOverride: "NONE",
    someNewQuestion: null,
  });
  expect(answers).toEqual({
    violenceRealistic: "NONE",
    profanityOrCrudeHumor: "NONE",
    gambling: false,
    lootBox: false,
    messagingAndChat: true,
    userGeneratedContent: true,
  });
  expect(unknown).toEqual(["someNewQuestion"]);
});

describe("screenshotPlan", () => {
  const wanted = [
    { fileName: "01.png", checksum: "a" },
    { fileName: "02.png", checksum: "b" },
    { fileName: "03.png", checksum: "c" },
  ];

  test("keeps matching screenshots in order, uploads new ones and deletes the rest", () => {
    const plan = screenshotPlan(
      [
        { id: "old", checksum: "x", deliveryState: "COMPLETE" },
        { id: "kept-c", checksum: "c", deliveryState: "COMPLETE" },
        { id: "kept-a", checksum: "a", deliveryState: "COMPLETE" },
      ],
      wanted,
    );
    expect(plan.order).toEqual([{ keep: "kept-a" }, { upload: wanted[1] }, { keep: "kept-c" }]);
    expect(plan.remove).toEqual(["old"]);
  });

  test("matches one screenshot to one file when two files are the same", () => {
    const twins = [
      { fileName: "01.png", checksum: "a" },
      { fileName: "02.png", checksum: "a" },
    ];
    const plan = screenshotPlan([{ id: "one", checksum: "a", deliveryState: "COMPLETE" }], twins);
    expect(plan.order).toEqual([{ keep: "one" }, { upload: twins[1] }]);
  });

  test("replaces a screenshot that Apple has not finished processing, even with the same file", () => {
    const plan = screenshotPlan(
      [
        { id: "processing", checksum: "a", deliveryState: "UPLOAD_COMPLETE" },
        { id: "failed", checksum: "b", deliveryState: "FAILED" },
        { id: "done", checksum: "c", deliveryState: "COMPLETE" },
      ],
      wanted,
    );
    expect(plan.order).toEqual([{ upload: wanted[0] }, { upload: wanted[1] }, { keep: "done" }]);
    expect(plan.remove).toEqual(["processing", "failed"]);
  });
});

describe("submissionStep", () => {
  const draft = { id: "draft", state: "READY_FOR_REVIEW" };

  test("creates a submission when none is open", () => {
    expect(submissionStep([], "v1")).toEqual({ kind: "create" });
  });

  test("finishes its own draft, adding the version when it is missing", () => {
    expect(submissionStep([{ ...draft, itemVersionIds: [] }], "v1")).toEqual({
      kind: "resume",
      submissionId: "draft",
      isAddingVersion: true,
    });
    expect(submissionStep([{ ...draft, itemVersionIds: ["v1"] }], "v1")).toEqual({
      kind: "resume",
      submissionId: "draft",
      isAddingVersion: false,
    });
  });

  test("finds its own draft among several, and resubmits one App Review sent back", () => {
    const other = { id: "other", state: "READY_FOR_REVIEW", itemVersionIds: ["v0"] };
    expect(submissionStep([other, { ...draft, itemVersionIds: ["v1"] }], "v1")).toMatchObject({
      kind: "resume",
      submissionId: "draft",
    });
    const sentBack = { id: "back", state: "UNRESOLVED_ISSUES", itemVersionIds: ["v1"] };
    expect(submissionStep([sentBack], "v1")).toMatchObject({
      kind: "resume",
      submissionId: "back",
    });
  });

  test("refuses while Apple reviews, or when only drafts with other items are open", () => {
    const reviewing = { id: "sent", state: "WAITING_FOR_REVIEW", itemVersionIds: ["v1"] };
    expect(submissionStep([reviewing], "v1")).toMatchObject({ kind: "refuse" });
    expect(submissionStep([{ ...draft, itemVersionIds: ["v1", null] }], "v1")).toMatchObject({
      kind: "refuse",
    });
    expect(submissionStep([{ ...draft, itemVersionIds: ["v0"] }], "v1")).toMatchObject({
      kind: "refuse",
    });
  });
});

describe("parseArgs", () => {
  test("reads the push options", () => {
    expect(parseArgs(["push", "--build", "15", "--screenshots", "out", "--dry-run"])).toEqual({
      command: "push",
      build: "15",
      screenshots: "out",
      isDryRun: true,
      isConfirmed: false,
    });
  });

  test("shows help without a command and refuses unknown input", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(() => parseArgs(["deploy"])).toThrow("Unknown command");
    expect(() => parseArgs(["push", "--build"])).toThrow("needs a value");
    expect(() => parseArgs(["push", "--force"])).toThrow("push does not take --force");
  });

  test("refuses an option the command does not take", () => {
    expect(() => parseArgs(["submit", "--dry-run"])).toThrow("submit does not take --dry-run");
    expect(() => parseArgs(["check", "--yes"])).toThrow("check does not take --yes");
    expect(parseArgs(["submit", "--yes", "--build", "15"])).toMatchObject({
      command: "submit",
      build: "15",
      isConfirmed: true,
    });
  });
});
