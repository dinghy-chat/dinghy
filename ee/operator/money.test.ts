// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, test } from "vitest";
import { formatMoney } from "./money.ts";

/** The same amount as the test's own locale writes it. */
const written = (value: number, currency: string, digits: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
  }).format(value);

test("an amount in Stripe's smallest unit shows as people write it", () => {
  expect(formatMoney({ amount: 900, currency: "usd" })).toBe(written(9, "usd", 0));
  expect(formatMoney({ amount: 950, currency: "usd" })).toBe(written(9.5, "usd", 2));
  // The yen has no minor unit, so 1500 is 1,500 yen, not 15.
  expect(formatMoney({ amount: 1500, currency: "jpy" })).toBe(written(1500, "jpy", 0));
  // Stripe counts the króna in hundredths, though people write it whole.
  expect(formatMoney({ amount: 150_000, currency: "isk" })).toBe(written(1500, "isk", 0));
});
