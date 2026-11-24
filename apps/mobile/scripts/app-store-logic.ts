/// <reference types="node" />
// The parts of app-store.ts that need no network, so tests can cover them.
import { createHash, sign } from "node:crypto";

const TOKEN_LIFETIME_S = 20 * 60;

export function jwtClaims(issuerId: string, nowSeconds: number) {
  return {
    iss: issuerId,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_S,
    aud: "appstoreconnect-v1",
  };
}

/** An ES256 token for the App Store Connect API. JWT wants the raw r||s signature, not DER. */
export function signToken(keyId: string, issuerId: string, privateKeyPem: string, nowMs: number) {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const header = encode({ alg: "ES256", kid: keyId, typ: "JWT" });
  const input = `${header}.${encode(jwtClaims(issuerId, Math.floor(nowMs / 1000)))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

export function md5(contents: Uint8Array) {
  return createHash("md5").update(contents).digest("hex");
}

/** The width and height from a PNG's IHDR chunk. */
export function pngSize(contents: Buffer) {
  if (contents.subarray(1, 4).toString("ascii") !== "PNG") throw new Error("Not a PNG file.");
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  // In a draft review submission that was never submitted, which submit finishes.
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

export function isEditable(appStoreState: unknown) {
  return typeof appStoreState === "string" && EDITABLE_STATES.has(appStoreState);
}

export type FieldStatus = "ok" | "differs" | "missing";

export function fieldStatus(wanted: unknown, actual: unknown): FieldStatus {
  if (actual === null || actual === undefined || actual === "") return "missing";
  return actual === wanted ? "ok" : "differs";
}

/** Questions Apple answers with NONE, INFREQUENT_OR_MILD or FREQUENT_OR_INTENSE. */
const FREQUENCY_QUESTIONS = new Set([
  "alcoholTobaccoOrDrugUseOrReferences",
  "contests",
  "gamblingSimulated",
  "gunsOrOtherWeapons",
  "horrorOrFearThemes",
  "matureOrSuggestiveThemes",
  "medicalOrTreatmentInformation",
  "profanityOrCrudeHumor",
  "sexualContentGraphicAndNudity",
  "sexualContentOrNudity",
  "violenceCartoonOrFantasy",
  "violenceRealistic",
  "violenceRealisticProlongedGraphicOrSadistic",
]);

const YES_NO_QUESTIONS = new Set([
  "advertising",
  "datingAndRelationships",
  "ageAssurance",
  "gambling",
  "healthOrWellnessTopics",
  "lootBox",
  "parentalControls",
  "sharedLocation",
  "socialMedia",
  "socialMediaAgeRestricted",
  "unrestrictedWebAccess",
]);

/** Visitors write the messages that operators read, so the app has chat and user content. */
export const YES_QUESTIONS = new Set(["messagingAndChat", "userGeneratedContent"]);

/** Overrides, the kids band, the info URL and retired questions keep what Apple has. */
const LEFT_ALONE = new Set([
  "ageRatingOverride",
  "ageRatingOverrideV2",
  "developerAgeRatingInfoUrl",
  "gamblingAndContests",
  "gracRatingClassificationNumber",
  "kidsAgeBand",
  "koreaAgeRatingOverride",
  "seventeenPlus",
]);

/**
 * The answers to write, from the attributes Apple's GET returned. A question this script does not
 * know goes to `unknown`, so a new Apple question is reported instead of guessed.
 */
export function ageRatingAnswers(current: Record<string, unknown>) {
  const answers: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(current)) {
    if (LEFT_ALONE.has(name)) continue;
    if (YES_QUESTIONS.has(name)) answers[name] = true;
    else if (FREQUENCY_QUESTIONS.has(name)) answers[name] = "NONE";
    else if (YES_NO_QUESTIONS.has(name) || typeof value === "boolean") answers[name] = false;
    else unknown.push(name);
  }
  return { answers, unknown };
}

export type Screenshot = { id: string; checksum: string | null; deliveryState: string };
export type WantedScreenshot = { fileName: string; checksum: string };

export const isDelivered = (shot: Screenshot) => shot.deliveryState === "COMPLETE";

/**
 * Which screenshots to keep, upload and delete. A screenshot on Apple's side is kept when its
 * checksum matches a file that has no match yet, and Apple finished processing it: one that is
 * still processing or failed matches nothing, so push uploads it again. `order` holds a kept id or
 * the file to upload.
 */
export function screenshotPlan(current: Screenshot[], wanted: WantedScreenshot[]) {
  const unmatched = [...current];
  const order = wanted.map((file) => {
    const index = unmatched.findIndex(
      (shot) => isDelivered(shot) && shot.checksum === file.checksum,
    );
    if (index === -1) return { upload: file };
    const [kept] = unmatched.splice(index, 1);
    return { keep: kept?.id ?? "" };
  });
  return { order, remove: unmatched.map((shot) => shot.id) };
}

/** The review submission that is open for the app, with the version of each of its items. */
export type OpenSubmission = { id: string; state: string; itemVersionIds: (string | null)[] };

export type SubmissionStep =
  | { kind: "create" }
  | { kind: "resume"; submissionId: string; isAddingVersion: boolean }
  | { kind: "refuse"; reason: string };

/**
 * A draft that holds nothing but this version is an earlier submit that stopped before it
 * finished, so submit picks it up. Apple keeps one open submission per platform, so anything else
 * open stops it.
 */
export function submissionStep(
  open: OpenSubmission | undefined,
  versionId: string,
): SubmissionStep {
  if (!open) return { kind: "create" };
  if (open.state !== "READY_FOR_REVIEW") {
    return { kind: "refuse", reason: `Submission ${open.id} is already open (${open.state}).` };
  }
  if (open.itemVersionIds.some((id) => id !== versionId)) {
    return {
      kind: "refuse",
      reason: `Draft submission ${open.id} holds other items. Remove them in App Store Connect.`,
    };
  }
  return {
    kind: "resume",
    submissionId: open.id,
    isAddingVersion: !open.itemVersionIds.includes(versionId),
  };
}

export type Options = {
  command: "check" | "push" | "submit" | "help";
  build: string | null;
  screenshots: string | null;
  isDryRun: boolean;
  isConfirmed: boolean;
};

/** The options each command takes, checked before any call to Apple. */
const FLAGS = {
  check: ["--build", "--screenshots"],
  push: ["--build", "--screenshots", "--dry-run"],
  submit: ["--build", "--screenshots", "--yes"],
};

export function parseArgs(args: string[]): Options {
  const [command = "help", ...rest] = args;
  const options: Options = {
    command: "help",
    build: null,
    screenshots: null,
    isDryRun: false,
    isConfirmed: false,
  };
  if (command === "check" || command === "push" || command === "submit") options.command = command;
  else if (command !== "help" && command !== "--help" && command !== "-h") {
    throw new Error(`Unknown command: ${command}`);
  }
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index] ?? "";
    if (options.command === "help" || !FLAGS[options.command].includes(flag)) {
      throw new Error(`${options.command} does not take ${flag}. Run help for the options.`);
    }
    if (flag === "--dry-run") options.isDryRun = true;
    else if (flag === "--yes") options.isConfirmed = true;
    else if (flag === "--build" || flag === "--screenshots") {
      const value = rest[++index];
      if (!value) throw new Error(`${flag} needs a value.`);
      if (flag === "--build") options.build = value;
      else options.screenshots = value;
    }
  }
  return options;
}
