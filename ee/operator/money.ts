// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import type { Money } from "../../apps/operator/src/api.ts";

/** An amount in the currency's smallest unit, as people write it, such as $9, $9.50 or ¥1,500. */
export function formatMoney({ amount, currency }: Money): string {
  const digits =
    new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const value = amount / 10 ** digits;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
  }).format(value);
}
