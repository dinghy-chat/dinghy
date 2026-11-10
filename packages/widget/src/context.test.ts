import { expect, test } from "vitest";
import { cleanContext } from "./context.ts";

test("setContext keeps strings, finite numbers, booleans and null", () => {
  expect(cleanContext({ plan: "pro", seats: 3, trial: false, coupon: null })).toEqual({
    plan: "pro",
    seats: 3,
    trial: false,
    coupon: null,
  });
});

test("setContext drops values and keys the server would refuse, and cuts long text", () => {
  const long = "x".repeat(300);
  expect(
    cleanContext({
      nested: { a: 1 },
      list: [1],
      infinite: Number.POSITIVE_INFINITY,
      missing: Number.NaN,
      gone: undefined,
      [long]: "key too long",
      "": "empty key",
      note: long,
    }),
  ).toEqual({ note: "x".repeat(200) });
});

test("setContext keeps the first 20 valid keys", () => {
  const data = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, index]));
  expect(Object.keys(cleanContext(data) ?? {})).toEqual(
    Array.from({ length: 20 }, (_, index) => `k${index}`),
  );
});

test("setContext with something other than an object sends nothing", () => {
  expect(cleanContext(null)).toBeNull();
  expect(cleanContext("plan=pro")).toBeNull();
  expect(cleanContext([["plan", "pro"]])).toBeNull();
});
