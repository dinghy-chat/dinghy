import { describe, expect, test } from "vitest";
import {
  bare,
  detailRows,
  isIdName,
  pageName,
  pagePath,
  pageRuns,
  webLink,
} from "./src/contact-logic.ts";

describe("page names and paths", () => {
  test("drops the site's name from the end of a title", () => {
    expect(pageName("Profile - Settings - Shipmail", "https://shipmail.to/settings")).toBe(
      "Profile - Settings",
    );
    expect(pageName("Pricing | Acme", "https://www.acme.co.uk/pricing")).toBe("Pricing");
  });

  test("keeps a title that does not end with the site's name", () => {
    expect(pageName("Mailboxes - Settings", "https://shipmail.to/settings")).toBe(
      "Mailboxes - Settings",
    );
    expect(pageName("Shipmail", "https://shipmail.to/")).toBe("Shipmail");
  });

  test("shows the path when the page has no title", () => {
    expect(pageName(null, "https://shipmail.to/settings/mailboxes?tab=2#dns")).toBe(
      "/settings/mailboxes?tab=2#dns",
    );
    expect(pageName("  ", "https://shipmail.to")).toBe("/");
  });

  test("a path never carries the origin", () => {
    expect(pagePath("https://app.shipmail.to:8443/inbox")).toBe("/inbox");
    expect(pagePath("app.shipmail.to/inbox")).toBe("app.shipmail.to/inbox");
    expect(bare("http://acme.example/pricing")).toBe("acme.example/pricing");
  });

  test("opens only web addresses", () => {
    expect(webLink("https://acme.example/a b")).toBeNull();
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink(42)).toBeNull();
    expect(webLink(" https://acme.example/x ")).toBe("https://acme.example/x");
  });
});

describe("page runs", () => {
  test("keeps pages on different sites separate", () => {
    const views = ["https://store.example/", "https://docs.example/"].map((path) => ({
      path,
      title: null,
      viewedAt: "2026-11-19T10:00:00Z",
    }));
    expect(pageRuns(views)).toHaveLength(2);
  });
  test("joins views of the same page that follow each other", () => {
    const view = (path: string, viewedAt: string) => ({ path, title: null, viewedAt });
    const runs = pageRuns([
      view("https://a.example/pricing", "2026-11-19T10:05:00Z"),
      view("https://a.example/pricing", "2026-11-19T10:04:00Z"),
      view("https://a.example/pricing#faq", "2026-11-19T10:03:00Z"),
      view("https://a.example/", "2026-11-19T10:02:00Z"),
      view("https://a.example/pricing", "2026-11-19T10:01:00Z"),
    ]);
    expect(runs.map((run) => [pagePath(run.path), run.views, run.viewedAt])).toEqual([
      ["/pricing", 2, "2026-11-19T10:05:00Z"],
      ["/pricing#faq", 1, "2026-11-19T10:03:00Z"],
      ["/", 1, "2026-11-19T10:02:00Z"],
      ["/pricing", 1, "2026-11-19T10:01:00Z"],
    ]);
  });
});

describe("details from the site", () => {
  test("lists the user ID, then signed attributes, then the page's context", () => {
    const rows = detailRows({
      userId: "u_123",
      attributes: { plan: "pro", seats: 4, admin: "https://app.example/org/org_8f2k1", empty: "" },
      pageContext: { orgId: "org_1", page: "https://evil.example" },
    });
    expect(rows).toEqual([
      { key: "userId", value: "u_123", link: null, signed: true, userId: true },
      { key: "plan", value: "pro", link: null, signed: true, userId: false },
      { key: "seats", value: "4", link: null, signed: true, userId: false },
      {
        key: "admin",
        value: "https://app.example/org/org_8f2k1",
        link: "https://app.example/org/org_8f2k1",
        signed: true,
        userId: false,
      },
      { key: "orgId", value: "org_1", link: null, signed: false, userId: false },
      // Anyone can change what the page sends, so its addresses stay text.
      { key: "page", value: "https://evil.example", link: null, signed: false, userId: false },
    ]);
  });

  test("keeps a long value whole, for the full view", () => {
    const long = "x".repeat(2000);
    expect(
      detailRows({ userId: null, attributes: { note: long }, pageContext: null })[0]?.value,
    ).toBe(long);
  });

  test("shows objects as JSON", () => {
    expect(
      detailRows({ userId: null, attributes: { tags: ["a", "b"] }, pageContext: null })[0]?.value,
    ).toBe('["a","b"]');
  });

  test("knows names of IDs", () => {
    expect(["id", "orgId", "account_id", "teamID"].every(isIdName)).toBe(true);
    expect(["idea", "paid", "width"].some(isIdName)).toBe(false);
  });
});
