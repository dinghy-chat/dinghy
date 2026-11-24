/// <reference types="node" />
// Sets up the Dinghy Chat listing on App Store Connect. Run `node apps/mobile/scripts/app-store.ts`
// for the commands. App Privacy is the one part Apple's API cannot set: see apps/mobile/STORE.md.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LISTING, SLIDES } from "../store/listing.ts";
import {
  ageRatingAnswers,
  type FieldStatus,
  fieldStatus,
  isDelivered,
  isEditable,
  md5,
  type Options,
  parseArgs,
  pngSize,
  type Screenshot,
  screenshotPlan,
  signToken,
  submissionStep,
  YES_QUESTIONS,
} from "./app-store-logic.ts";

const USAGE = `Usage: node apps/mobile/scripts/app-store.ts <command> [options]

Commands:
  check                    Compare App Store Connect with store/listing.ts. Exits 1 when
                           something is missing or differs.
  push                     Write the listing, review details, age rating, build, screenshots
                           and price.
    --build <number>       The build to attach. Defaults to ios.buildNumber in app.config.js.
    --screenshots <dir>    Defaults to apps/mobile/store/output/composed/iphone-6.9.
    --dry-run              Print every write and make none.
  submit                   Show what a review submission would do. It finishes a draft
                           submission that an earlier submit left.
    --yes                  Submit the version for review.

check and submit also take --build and --screenshots.

Environment:
  ASC_ISSUER_ID            Required.
  ASC_KEY_ID               Defaults to B482423883.
  ASC_KEY_PATH             Defaults to ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8.
  ASC_REVIEW_CONTACT_FIRST_NAME, ASC_REVIEW_CONTACT_LAST_NAME, ASC_REVIEW_CONTACT_PHONE,
  ASC_REVIEW_CONTACT_EMAIL, ASC_DEMO_EMAIL, ASC_DEMO_CODE
                           Required by push.`;

const APP_ID = "6836451908";
const BUNDLE_ID = "chat.dinghy.operator";
const DEFAULT_KEY_ID = "B482423883";
const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const DISPLAY_TYPE = "APP_IPHONE_67";
const SCREENSHOT_WIDTH_PX = 1320;
const SCREENSHOT_HEIGHT_PX = 2868;
const MOBILE_DIR = join(import.meta.dirname, "..");
const DEFAULT_SCREENSHOTS_DIR = join(MOBILE_DIR, "store", "output", "composed", "iphone-6.9");
const DELIVERY_POLL_MS = 3_000;
const DELIVERY_POLL_ATTEMPTS = 60;
/** The id a dry run gives to a resource it would create. */
const DRY_ID = "(new)";
/** Apple's placeholder id that links the new price to the schedule in one request. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Apple's syntax, not a template.
const NEW_PRICE_ID = "${price}";
const REVIEW_ENV = {
  contactFirstName: "ASC_REVIEW_CONTACT_FIRST_NAME",
  contactLastName: "ASC_REVIEW_CONTACT_LAST_NAME",
  contactPhone: "ASC_REVIEW_CONTACT_PHONE",
  contactEmail: "ASC_REVIEW_CONTACT_EMAIL",
  demoAccountName: "ASC_DEMO_EMAIL",
  demoAccountPassword: "ASC_DEMO_CODE",
} as const;
const OPEN_SUBMISSION_STATES = new Set([
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "CANCELING",
  "COMPLETING",
]);

const appConfig = createRequire(import.meta.url)("../app.config.js") as {
  version: string;
  ios: { buildNumber: string; bundleIdentifier: string };
};

type Resource = {
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string } | null }>;
};
type Api = ReturnType<typeof createApi>;

function attr(resource: Resource | null | undefined, name: string): unknown {
  return resource?.attributes?.[name];
}

function relatedId(resource: Resource | undefined, name: string) {
  return resource?.relationships?.[name]?.data?.id ?? null;
}

function createApi(isDryRun: boolean) {
  const issuerId = process.env.ASC_ISSUER_ID;
  if (!issuerId) throw new Error("Set ASC_ISSUER_ID. STORE.md says where it lives.");
  const issuer = issuerId;
  const keyId = process.env.ASC_KEY_ID || DEFAULT_KEY_ID;
  const keyPath =
    process.env.ASC_KEY_PATH ||
    join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
  if (!existsSync(keyPath)) throw new Error(`No API key file at ${keyPath}. Set ASC_KEY_PATH.`);
  const privateKeyPem = readFileSync(keyPath, "utf8");

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${signToken(keyId, issuer, privateKeyPem, Date.now())}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}.\n${text}`);
    return text ? (JSON.parse(text) as { data: Resource | Resource[] | null }) : null;
  }

  return {
    isDryRun,
    async one(path: string) {
      const document = await request("GET", path);
      const data = document?.data;
      return data && !Array.isArray(data) ? data : null;
    },
    async many(path: string) {
      const data = (await request("GET", path))?.data;
      return Array.isArray(data) ? data : [];
    },
    /** A write. A dry run prints it and returns null. */
    async send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
      if (isDryRun) {
        console.log(`  would ${method} ${path}${body ? ` ${describeBody(body)}` : ""}`);
        return null;
      }
      const data = (await request(method, path, body))?.data;
      return data && !Array.isArray(data) ? data : null;
    },
  };
}

/** The body of a planned write, without the demo account's code. */
function describeBody(body: unknown) {
  return JSON.stringify(body, (key, value) =>
    key === "demoAccountPassword" && value ? "(hidden)" : value,
  );
}

function resource(type: string, id: string) {
  return { data: { type, id } };
}

async function findState(api: Api) {
  const infos = await api.many(
    `/v1/apps/${APP_ID}/appInfos?include=primaryCategory,secondaryCategory`,
  );
  const appInfo = infos.find((info) => isEditable(attr(info, "state"))) ?? infos[0];
  if (!appInfo) throw new Error(`App ${APP_ID} has no app info. Check the key's access.`);
  const versions = await api.many(
    `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`,
  );
  const version = versions.find((candidate) => isEditable(attr(candidate, "appStoreState")));
  return { appInfo, version, versions };
}

async function findLocalization(api: Api, path: string) {
  const localizations = await api.many(path);
  return localizations.find((item) => attr(item, "locale") === LISTING.locale);
}

function composedScreenshots(dir: string) {
  return SLIDES.map((slide) => {
    const fileName = `${slide.name}.png`;
    const path = join(dir, fileName);
    if (!existsSync(path)) throw new Error(`Missing screenshot ${path}. Compose them first.`);
    const contents = readFileSync(path);
    const { width, height } = pngSize(contents);
    if (width !== SCREENSHOT_WIDTH_PX || height !== SCREENSHOT_HEIGHT_PX) {
      throw new Error(`${fileName} is ${width}x${height}, not 1320x2868.`);
    }
    return { fileName, contents, checksum: md5(contents) };
  });
}

async function screenshotSet(api: Api, localizationId: string | undefined) {
  if (!localizationId || localizationId === DRY_ID) return undefined;
  const sets = await api.many(
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`,
  );
  return sets.find((set) => attr(set, "screenshotDisplayType") === DISPLAY_TYPE);
}

async function screenshotsIn(api: Api, setId: string | undefined): Promise<Screenshot[]> {
  if (!setId || setId === DRY_ID) return [];
  const shots = await api.many(`/v1/appScreenshotSets/${setId}/appScreenshots?limit=50`);
  return shots.map((shot) => ({
    id: shot.id,
    checksum: (attr(shot, "sourceFileChecksum") as string | null) ?? null,
    deliveryState: deliveryState(shot),
  }));
}

function deliveryState(screenshot: Resource | null) {
  const state = attr(screenshot, "assetDeliveryState") as { state?: string } | null | undefined;
  return state?.state ?? "UNKNOWN";
}

async function priceSchedule(api: Api) {
  const schedule = await api.one(`/v1/apps/${APP_ID}/appPriceSchedule`);
  if (!schedule) return null;
  const prices = await api.many(`/v1/appPriceSchedules/${schedule.id}/manualPrices?limit=1`);
  return prices.length > 0 ? schedule : null;
}

// check

type Row = { label: string; status: FieldStatus; detail: string };

function compare(label: string, wanted: unknown, actual: unknown): Row {
  const status = fieldStatus(wanted, actual);
  return {
    label,
    status,
    detail: status === "differs" ? `has ${JSON.stringify(actual)}` : "",
  };
}

function present(label: string, isPresent: boolean, detail = ""): Row {
  return { label, status: isPresent ? "ok" : "missing", detail };
}

async function checkRows(api: Api, options: Options) {
  const { appInfo, version } = await findState(api);
  const rows: Row[] = [];
  const infoLocalization = await findLocalization(
    api,
    `/v1/appInfos/${appInfo.id}/appInfoLocalizations`,
  );
  for (const field of ["name", "subtitle", "privacyPolicyUrl"] as const) {
    rows.push(compare(field, LISTING[field], attr(infoLocalization, field)));
  }
  rows.push(
    compare("primaryCategory", LISTING.primaryCategory, relatedId(appInfo, "primaryCategory")),
    compare(
      "secondaryCategory",
      LISTING.secondaryCategory,
      relatedId(appInfo, "secondaryCategory"),
    ),
  );
  rows.push(...(await ageRatingRows(api, appInfo.id)));
  if (!version) {
    rows.push(present("editable version", false, "push creates it"));
    return rows;
  }
  rows.push(
    compare("versionString", appConfig.version, attr(version, "versionString")),
    compare("copyright", LISTING.copyright, attr(version, "copyright")),
    compare("releaseType", "AFTER_APPROVAL", attr(version, "releaseType")),
  );
  const localization = await findLocalization(
    api,
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
  );
  for (const field of [
    "description",
    "keywords",
    "promotionalText",
    "supportUrl",
    "marketingUrl",
  ] as const) {
    rows.push(compare(field, LISTING[field], attr(localization, field)));
  }
  rows.push(...(await reviewRows(api, version.id)));
  rows.push(await screenshotRow(api, localization?.id, options));
  rows.push(await buildRow(api, version.id, options.build ?? appConfig.ios.buildNumber));
  rows.push(present("price schedule", (await priceSchedule(api)) !== null));
  return rows;
}

async function ageRatingRows(api: Api, appInfoId: string): Promise<Row[]> {
  const declaration = await api.one(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`);
  if (!declaration) return [present("age rating", false)];
  const { answers, unknown } = ageRatingAnswers(declaration.attributes ?? {});
  const wrong = Object.entries(answers).filter(
    ([name, value]) => attr(declaration, name) !== value,
  );
  const rows = [present("age rating", wrong.length === 0, wrong.map(([name]) => name).join(", "))];
  if (unknown.length > 0) {
    rows.push(present("age rating questions this script does not know", false, unknown.join(", ")));
  }
  return rows;
}

async function reviewRows(api: Api, versionId: string): Promise<Row[]> {
  const detail = await api.one(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  const rows = Object.entries(REVIEW_ENV).map(([field, envName]) => {
    const wanted = process.env[envName];
    return wanted
      ? compare(field, wanted, attr(detail, field))
      : present(field, !!attr(detail, field));
  });
  rows.push(
    compare("demoAccountRequired", true, attr(detail, "demoAccountRequired")),
    compare("review notes", LISTING.reviewNotes, attr(detail, "notes")),
  );
  return rows.map((row) => (row.label === "demoAccountPassword" ? { ...row, detail: "" } : row));
}

async function screenshotRow(api: Api, localizationId: string | undefined, options: Options) {
  const set = await screenshotSet(api, localizationId);
  const current = await screenshotsIn(api, set?.id);
  const undelivered = current.filter((shot) => !isDelivered(shot));
  const detail = [
    `${current.length} on Apple, ${SLIDES.length} wanted`,
    ...(undelivered.length > 0
      ? [
          `${undelivered.length} not processed by Apple (${undelivered.map((shot) => shot.deliveryState).join(", ")}), push uploads them again`,
        ]
      : []),
  ].join("; ");
  const dir = options.screenshots ?? DEFAULT_SCREENSHOTS_DIR;
  if (!existsSync(dir)) {
    return present("screenshots", false, `${detail}; no composed files in ${dir}`);
  }
  const plan = screenshotPlan(current, composedScreenshots(dir));
  const isSame =
    plan.remove.length === 0 &&
    plan.order.every((step, index) => "keep" in step && step.keep === current[index]?.id);
  return present(`screenshots ${DISPLAY_TYPE}`, isSame, detail);
}

async function buildRow(api: Api, versionId: string, buildNumber: string): Promise<Row> {
  const build = await api.one(`/v1/appStoreVersions/${versionId}/build`);
  if (!build) return present("build", false, `build ${buildNumber} is not attached`);
  const state = attr(build, "processingState");
  const detail = `build ${String(attr(build, "version"))}, ${String(state)}`;
  if (attr(build, "version") !== buildNumber) {
    return { label: "build", status: "differs", detail: `${detail}, wanted ${buildNumber}` };
  }
  return present("build", state === "VALID", detail);
}

function printRows(rows: Row[]) {
  const width = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(width)}  ${row.status}${row.detail ? `  (${row.detail})` : ""}`,
    );
  }
  const notReady = rows.filter((row) => row.status !== "ok");
  console.log(
    notReady.length === 0
      ? "\nReady for review."
      : `\nNot ready: ${notReady.map((row) => row.label).join(", ")}.`,
  );
  return notReady.length === 0;
}

// push

function reviewContact(isDryRun: boolean) {
  const unset = Object.values(REVIEW_ENV).filter((name) => !process.env[name]);
  if (unset.length > 0) {
    const message = `Set ${unset.join(", ")}. STORE.md says where they live.`;
    if (!isDryRun) throw new Error(message);
    console.log(`Warning: ${message}`);
  }
  return Object.fromEntries(
    Object.entries(REVIEW_ENV).map(([field, envName]) => [field, process.env[envName] ?? ""]),
  );
}

async function push(api: Api, options: Options) {
  const contact = reviewContact(api.isDryRun);
  const dir = options.screenshots ?? DEFAULT_SCREENSHOTS_DIR;
  const isSkippingScreenshots = api.isDryRun && !existsSync(dir);
  const screenshots = isSkippingScreenshots ? [] : composedScreenshots(dir);
  const { appInfo, version: found } = await findState(api);
  const versionId = await pushVersion(api, found);
  await pushAppInfo(api, appInfo);
  await pushAgeRating(api, appInfo.id);
  const localizationId = await pushVersionLocalization(api, versionId);
  await pushReviewDetail(api, versionId, contact);
  await pushBuild(api, versionId, options.build ?? appConfig.ios.buildNumber);
  if (isSkippingScreenshots) console.log(`Skipping screenshots: no composed files in ${dir}.`);
  else await pushScreenshots(api, localizationId, screenshots);
  await pushPrice(api);
  console.log(api.isDryRun ? "\nDry run: nothing was written." : "\nDone. Run check to confirm.");
}

async function pushVersion(api: Api, version: Resource | undefined) {
  const attributes = {
    versionString: appConfig.version,
    copyright: LISTING.copyright,
    releaseType: "AFTER_APPROVAL",
  };
  if (!version) {
    console.log(`Creating version ${appConfig.version}.`);
    const created = await api.send("POST", "/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { ...attributes, platform: "IOS" },
        relationships: { app: resource("apps", APP_ID) },
      },
    });
    return created?.id ?? DRY_ID;
  }
  const changed = Object.entries(attributes).filter(
    ([name, value]) => attr(version, name) !== value,
  );
  console.log(
    `Version ${String(attr(version, "versionString"))} (${String(attr(version, "appStoreState"))}).`,
  );
  if (changed.length > 0) {
    await api.send("PATCH", `/v1/appStoreVersions/${version.id}`, {
      data: { type: "appStoreVersions", id: version.id, attributes: Object.fromEntries(changed) },
    });
  }
  return version.id;
}

async function pushAppInfo(api: Api, appInfo: Resource) {
  const categories = {
    primaryCategory: LISTING.primaryCategory,
    secondaryCategory: LISTING.secondaryCategory,
  };
  const changed = Object.entries(categories).filter(
    ([name, id]) => relatedId(appInfo, name) !== id,
  );
  if (changed.length > 0) {
    await api.send("PATCH", `/v1/appInfos/${appInfo.id}`, {
      data: {
        type: "appInfos",
        id: appInfo.id,
        relationships: Object.fromEntries(
          changed.map(([name, id]) => [name, resource("appCategories", id)]),
        ),
      },
    });
  }
  const localization = await findLocalization(
    api,
    `/v1/appInfos/${appInfo.id}/appInfoLocalizations`,
  );
  const attributes = {
    name: LISTING.name,
    subtitle: LISTING.subtitle,
    privacyPolicyUrl: LISTING.privacyPolicyUrl,
  };
  await upsertLocalization(api, "appInfoLocalizations", localization, attributes, {
    appInfo: resource("appInfos", appInfo.id),
  });
}

/** Creates the en-US localization or patches the fields that differ. Returns its id. */
async function upsertLocalization(
  api: Api,
  type: string,
  current: Resource | undefined,
  attributes: Record<string, string>,
  relationships: Record<string, unknown>,
) {
  if (!current) {
    const created = await api.send("POST", `/v1/${type}`, {
      data: { type, attributes: { ...attributes, locale: LISTING.locale }, relationships },
    });
    return created?.id ?? DRY_ID;
  }
  const changed = Object.entries(attributes).filter(
    ([name, value]) => attr(current, name) !== value,
  );
  if (changed.length > 0) {
    await api.send("PATCH", `/v1/${type}/${current.id}`, {
      data: { type, id: current.id, attributes: Object.fromEntries(changed) },
    });
  }
  return current.id;
}

async function pushAgeRating(api: Api, appInfoId: string) {
  const declaration = await api.one(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`);
  if (!declaration) throw new Error("App Store Connect returned no age rating declaration.");
  const { answers, unknown } = ageRatingAnswers(declaration.attributes ?? {});
  const yes = Object.keys(answers).filter((name) => YES_QUESTIONS.has(name));
  if (yes.length > 0) {
    console.log(`Age rating: answering yes to ${yes.join(", ")}, because visitors send messages.`);
  }
  if (unknown.length > 0) {
    console.log(`Age rating: left unanswered, answer by hand: ${unknown.join(", ")}.`);
  }
  const changed = Object.entries(answers).filter(
    ([name, value]) => attr(declaration, name) !== value,
  );
  if (changed.length === 0) return;
  await api.send("PATCH", `/v1/ageRatingDeclarations/${declaration.id}`, {
    data: {
      type: "ageRatingDeclarations",
      id: declaration.id,
      attributes: Object.fromEntries(changed),
    },
  });
}

async function pushVersionLocalization(api: Api, versionId: string) {
  const current =
    versionId === DRY_ID
      ? undefined
      : await findLocalization(
          api,
          `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
        );
  const attributes = {
    description: LISTING.description,
    keywords: LISTING.keywords,
    promotionalText: LISTING.promotionalText,
    supportUrl: LISTING.supportUrl,
    marketingUrl: LISTING.marketingUrl,
  };
  return upsertLocalization(api, "appStoreVersionLocalizations", current, attributes, {
    appStoreVersion: resource("appStoreVersions", versionId),
  });
}

async function pushReviewDetail(api: Api, versionId: string, contact: Record<string, string>) {
  const attributes: Record<string, unknown> = {
    ...contact,
    demoAccountRequired: true,
    notes: LISTING.reviewNotes,
  };
  const current =
    versionId === DRY_ID
      ? null
      : await api.one(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (!current) {
    await api.send("POST", "/v1/appStoreReviewDetails", {
      data: {
        type: "appStoreReviewDetails",
        attributes,
        relationships: { appStoreVersion: resource("appStoreVersions", versionId) },
      },
    });
    return;
  }
  const changed = Object.entries(attributes).filter(
    ([name, value]) => attr(current, name) !== value,
  );
  if (changed.length === 0) return;
  await api.send("PATCH", `/v1/appStoreReviewDetails/${current.id}`, {
    data: {
      type: "appStoreReviewDetails",
      id: current.id,
      attributes: Object.fromEntries(changed),
    },
  });
}

async function pushBuild(api: Api, versionId: string, buildNumber: string) {
  const [build] = await api.many(
    `/v1/builds?filter[app]=${APP_ID}&filter[version]=${buildNumber}&filter[preReleaseVersion.platform]=IOS&limit=1`,
  );
  const state = attr(build, "processingState");
  if (!build || state !== "VALID") {
    console.log(
      `Build ${buildNumber} is ${build ? String(state) : "not uploaded"}. Run push again once it is VALID.`,
    );
    return;
  }
  const attached =
    versionId === DRY_ID ? null : await api.one(`/v1/appStoreVersions/${versionId}/build`);
  if (attached?.id === build.id) return;
  await api.send("PATCH", `/v1/appStoreVersions/${versionId}/relationships/build`, {
    data: { type: "builds", id: build.id },
  });
}

type ComposedScreenshot = ReturnType<typeof composedScreenshots>[number];

async function pushScreenshots(
  api: Api,
  localizationId: string,
  screenshots: ComposedScreenshot[],
) {
  let setId = (await screenshotSet(api, localizationId))?.id;
  if (!setId) {
    const created = await api.send("POST", "/v1/appScreenshotSets", {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: DISPLAY_TYPE },
        relationships: {
          appStoreVersionLocalization: resource("appStoreVersionLocalizations", localizationId),
        },
      },
    });
    setId = created?.id ?? DRY_ID;
  }
  const plan = screenshotPlan(await screenshotsIn(api, setId), screenshots);
  for (const id of plan.remove) await api.send("DELETE", `/v1/appScreenshots/${id}`);
  const orderedIds: string[] = [];
  for (const step of plan.order) {
    if ("keep" in step) orderedIds.push(step.keep);
    else {
      const file = screenshots.find((shot) => shot.fileName === step.upload.fileName);
      if (file) orderedIds.push(await uploadScreenshot(api, setId, file));
    }
  }
  await api.send("PATCH", `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
    data: orderedIds.map((id) => ({ type: "appScreenshots", id })),
  });
}

async function uploadScreenshot(api: Api, setId: string, file: ComposedScreenshot) {
  console.log(`Uploading ${file.fileName}.`);
  const reserved = await api.send("POST", "/v1/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName: file.fileName, fileSize: file.contents.byteLength },
      relationships: { appScreenshotSet: resource("appScreenshotSets", setId) },
    },
  });
  if (!reserved) {
    console.log(`  would PUT ${file.contents.byteLength} bytes to Apple's upload URLs`);
    return DRY_ID;
  }
  const operations = attr(reserved, "uploadOperations") as UploadOperation[] | null;
  for (const operation of operations ?? []) await putPart(operation, file.contents);
  await api.send("PATCH", `/v1/appScreenshots/${reserved.id}`, {
    data: {
      type: "appScreenshots",
      id: reserved.id,
      attributes: { uploaded: true, sourceFileChecksum: file.checksum },
    },
  });
  await waitForDelivery(api, reserved.id, file.fileName);
  return reserved.id;
}

type UploadOperation = {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
};

async function putPart(operation: UploadOperation, contents: Buffer) {
  const response = await fetch(operation.url, {
    method: operation.method,
    headers: operation.requestHeaders.map((header): [string, string] => [
      header.name,
      header.value,
    ]),
    body: Uint8Array.from(contents.subarray(operation.offset, operation.offset + operation.length)),
  });
  if (!response.ok) throw new Error(`Screenshot upload failed with ${response.status}.`);
}

async function waitForDelivery(api: Api, screenshotId: string, fileName: string) {
  for (let attempt = 0; attempt < DELIVERY_POLL_ATTEMPTS; attempt++) {
    const state = deliveryState(await api.one(`/v1/appScreenshots/${screenshotId}`));
    if (state === "COMPLETE") return;
    if (state === "FAILED") throw new Error(`Apple could not process ${fileName}.`);
    await delay(DELIVERY_POLL_MS);
  }
  throw new Error(`${fileName} was still processing after ${DELIVERY_POLL_ATTEMPTS} checks.`);
}

async function pushPrice(api: Api) {
  if (await priceSchedule(api)) return;
  const points = await api.many(
    `/v1/apps/${APP_ID}/appPricePoints?filter[territory]=USA&limit=200`,
  );
  const free = points.find((point) => Number(attr(point, "customerPrice")) === 0);
  if (!free) throw new Error("Apple returned no free price point for the USA.");
  console.log("Setting the price to free.");
  await api.send("POST", "/v1/appPriceSchedules", {
    data: {
      type: "appPriceSchedules",
      relationships: {
        app: resource("apps", APP_ID),
        baseTerritory: resource("territories", "USA"),
        manualPrices: { data: [{ type: "appPrices", id: NEW_PRICE_ID }] },
      },
    },
    included: [
      {
        type: "appPrices",
        id: NEW_PRICE_ID,
        attributes: { startDate: null },
        relationships: { appPricePoint: resource("appPricePoints", free.id) },
      },
    ],
  });
}

// submit

async function submit(api: Api, options: Options) {
  if (!printRows(await checkRows(api, options))) {
    throw new Error("Refusing to submit: run push first, then check.");
  }
  const { version } = await findState(api);
  if (!version) throw new Error("No editable version to submit.");
  const step = submissionStep(await openSubmissions(api), version.id);
  if (step.kind === "refuse") throw new Error(step.reason);
  const versionString = String(attr(version, "versionString"));
  if (!options.isConfirmed) {
    const draft = step.kind === "resume" ? ` with draft submission ${step.submissionId}` : "";
    console.log(`\nWould submit version ${versionString}${draft}. Add --yes.`);
    return;
  }
  const submissionId = step.kind === "resume" ? step.submissionId : await createSubmission(api);
  if (step.kind === "create" || step.isAddingVersion) {
    await api.send("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: resource("reviewSubmissions", submissionId),
          appStoreVersion: resource("appStoreVersions", version.id),
        },
      },
    });
  }
  await api.send("PATCH", `/v1/reviewSubmissions/${submissionId}`, {
    data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
  });
  console.log(`Submitted version ${versionString} for review.`);
}

async function openSubmissions(api: Api) {
  const submissions = await api.many(
    `/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS&limit=20`,
  );
  const open = submissions.filter((item) =>
    OPEN_SUBMISSION_STATES.has(String(attr(item, "state"))),
  );
  return Promise.all(
    open.map(async (submission) => {
      const items = await api.many(
        `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion`,
      );
      return {
        id: submission.id,
        state: String(attr(submission, "state")),
        itemVersionIds: items.map((item) => relatedId(item, "appStoreVersion")),
      };
    }),
  );
}

async function createSubmission(api: Api) {
  const created = await api.send("POST", "/v1/reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform: "IOS" },
      relationships: { app: resource("apps", APP_ID) },
    },
  });
  if (!created) throw new Error("Apple returned no review submission.");
  return created.id;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    console.log(USAGE);
    return;
  }
  if (appConfig.ios.bundleIdentifier !== BUNDLE_ID) {
    throw new Error(
      `app.config.js has bundle ${appConfig.ios.bundleIdentifier}, not ${BUNDLE_ID}.`,
    );
  }
  const api = createApi(options.isDryRun);
  if (options.command === "check")
    process.exitCode = printRows(await checkRows(api, options)) ? 0 : 1;
  else if (options.command === "push") await push(api, options);
  else await submit(api, options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
