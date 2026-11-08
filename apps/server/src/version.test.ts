import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const packageVersion = (path: string) => (JSON.parse(read(path)) as { version: string }).version;

// A release changes all of these together. `/v1/meta` reports the server package's version.
test("every place that names the release names the same version", () => {
  const release = /ghcr\.io\/dinghy-chat\/dinghy:([0-9.]+)\}/.exec(read("compose.yaml"))?.[1];
  expect(release).toMatch(/^\d+\.\d+\.\d+$/);
  expect({
    root: packageVersion("package.json"),
    server: packageVersion("apps/server/package.json"),
    operator: packageVersion("apps/operator/package.json"),
    widget: packageVersion("packages/widget/package.json"),
    ee: packageVersion("ee/package.json"),
    installer: /^version="([0-9.]+)"/m.exec(read("install.sh"))?.[1],
    // bun install --frozen-lockfile fails when the lockfile keeps an old workspace version.
    lockfile: [
      ...new Set(
        [...read("bun.lock").matchAll(/"name": "@?dinghy[^"]*",\s*"version": "([^"]+)"/g)].map(
          (found) => found[1],
        ),
      ),
    ].join(),
  }).toEqual({
    root: release,
    server: release,
    operator: release,
    widget: release,
    ee: release,
    installer: release,
    lockfile: release,
  });
});
