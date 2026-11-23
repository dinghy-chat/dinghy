// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, test } from "vitest";
import { formatMoney } from "./money.ts";

test("an amount in the smallest unit shows in the currency's own precision", () => {
  const shown = (amount: number, currency: string) =>
    formatMoney({ amount, currency }).replace(/\s/g, " ");
  expect(shown(900, "usd")).toMatch(/^\$9$|^US\$9$/);
  expect(shown(950, "usd")).toMatch(/9\.50/);
  // The yen has no minor unit, so 1500 is ¥1,500, not ¥15.
  expect(shown(1500, "jpy")).toMatch(/1,500/);
});
