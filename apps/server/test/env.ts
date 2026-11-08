export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
export const AUTH_SECRET = "a-test-secret-with-at-least-32-characters";
export const PUBLIC_URL = "http://localhost:3000";
export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://127.0.0.1:56379";
export const S3 = {
  endpoint: process.env.S3_TEST_ENDPOINT ?? "http://127.0.0.1:59000",
  region: "us-east-1",
  accessKeyId: "dinghy-dev",
  secretAccessKey: "dinghy-dev-secret",
};

/** A socket address as the Node server gives it, so a test request behaves like a real one. */
export const fromSocket = (address: string) => ({
  incoming: { socket: { remoteAddress: address } },
});
