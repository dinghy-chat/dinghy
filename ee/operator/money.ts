// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Money } from "../../apps/operator/src/api.ts";

/** Currencies that Stripe counts in hundredths although people write them whole. */
const STRIPE_DECIMALS: Partial<Record<string, number>> = { isk: 2, ugx: 2, huf: 2, twd: 2 };

/** An amount in Stripe's smallest unit, as people write it, such as $9, $9.50 or ¥1,500. */
export function formatMoney({ amount, currency }: Money): string {
  const written =
    new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const value = amount / 10 ** (STRIPE_DECIMALS[currency.toLowerCase()] ?? written);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : written,
    maximumFractionDigits: written,
  }).format(value);
}
