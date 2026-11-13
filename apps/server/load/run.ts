// Opens streams the way the widget does, sends messages at a fixed rate, and reports the time
// from a send to its delivery. Run it on another machine, or on CPUs the server does not use.
// Usage: node apps/server/load/run.ts <base URL> <public key> <origin> <streams> <messages per second> <seconds>
//   [--image <JPEG file> --image-rate <uploads per second>]
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { image: { type: "string" }, "image-rate": { type: "string" } },
});
const [base, key, origin, streamsArg, rateArg, secondsArg] = positionals;
if (base === undefined || key === undefined || origin === undefined) {
  throw new Error("Usage: run.ts <base URL> <public key> <origin> <streams> <rate> <seconds>");
}
const STREAMS = Number(streamsArg);
const RATE = Number(rateArg);
const SECONDS = Number(secondsArg);
const SETUP_CONCURRENCY = 25;
const IMAGE = values.image === undefined ? null : readFileSync(values.image);
const IMAGE_RATE = Number(values["image-rate"] ?? 0);

const url = new URL(base);
const client = url.protocol === "https:" ? https : http;
const agent = new client.Agent({ keepAlive: true, maxSockets: Number.POSITIVE_INFINITY });

function request(method: string, path: string, token?: string, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = client.request(
      {
        agent,
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          origin,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const latencies: number[] = [];
const closes: Record<string, number> = {};
const errors: Record<string, number> = {};
const count = (bucket: Record<string, number>, name: string) => {
  bucket[name] = (bucket[name] ?? 0) + 1;
};
let open = 0;

function openStream(token: string) {
  return new Promise<void>((resolve, reject) => {
    const req = client.request(
      {
        host: url.hostname,
        port: url.port,
        agent: false,
        path: `/v1/widget/${key}/stream`,
        headers: { origin, authorization: `Bearer ${token}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`stream status ${res.statusCode}`));
          return;
        }
        open += 1;
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end === -1) break;
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith("event: ready")) resolve();
            const sent = /"body":"t:(\d+)"/.exec(block);
            if (sent?.[1] !== undefined) latencies.push(Date.now() - Number(sent[1]));
            const closed = /"reason":"(\w+)"/.exec(block);
            if (closed?.[1] !== undefined) count(closes, closed[1]);
          }
        });
        res.on("close", () => {
          open -= 1;
        });
      },
    );
    req.on("error", (error) => {
      count(errors, error.message);
      reject(error);
    });
    req.end();
  });
}

async function inBatches(total: number, work: (index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SETUP_CONCURRENCY, total) }, async () => {
      while (next < total) {
        const index = next;
        next += 1;
        await work(index).catch((error: Error) => count(errors, error.message));
      }
    }),
  );
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const tokens: string[] = [];
const setupStarted = Date.now();
await inBatches(STREAMS, async () => {
  const { status, text } = await request("POST", `/v1/widget/${key}/visitors`);
  if (status !== 201) throw new Error(`visitor status ${status}`);
  tokens.push((JSON.parse(text) as { token: string }).token);
});
const visitorsMs = Date.now() - setupStarted;

const streamsStarted = Date.now();
await inBatches(tokens.length, async (index) => {
  const token = tokens[index];
  if (token !== undefined) await openStream(token);
});
const streamsMs = Date.now() - streamsStarted;

function uploadImage(token: string, number: number, bytes: Uint8Array) {
  const started = Date.now();
  return new Promise<void>((resolve) => {
    const req = client.request(
      {
        // Its own connection, as from another browser. A refused upload closes its connection.
        agent: false,
        host: url.hostname,
        port: url.port,
        method: "POST",
        path: `/v1/widget/${key}/uploads?clientId=image-${number}`,
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          "content-type": "image/jpeg",
          "content-length": bytes.length,
          // Each upload from its own address, because the server limits uploads per address.
          "x-forwarded-for": `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          count(imageStatuses, String(res.statusCode));
          if (res.statusCode === 201) imageTimes.push(Date.now() - started);
          resolve();
        });
      },
    );
    req.on("error", (error) => {
      count(imageStatuses, error.message);
      resolve();
    });
    req.end(bytes);
  });
}

let sent = 0;
let failed = 0;
let sequence = 0;
const sendTimes: number[] = [];
const imageTimes: number[] = [];
const imageStatuses: Record<string, number> = {};
const imageRequests: Promise<void>[] = [];
const sendStarted = Date.now();
const imagesFinished = new Promise<void>((resolve) => {
  if (IMAGE === null || IMAGE_RATE === 0) {
    resolve();
    return;
  }
  let imageNumber = 0;
  const timer = setInterval(() => {
    if (Date.now() - sendStarted >= SECONDS * 1000) {
      clearInterval(timer);
      void Promise.all(imageRequests).then(() => resolve());
      return;
    }
    imageNumber += 1;
    const token = tokens[imageNumber % tokens.length];
    if (token !== undefined) imageRequests.push(uploadImage(token, imageNumber, IMAGE));
  }, 1000 / IMAGE_RATE);
});
await new Promise<void>((resolve) => {
  const timer = setInterval(
    () => {
      if (Date.now() - sendStarted >= SECONDS * 1000) {
        clearInterval(timer);
        resolve();
        return;
      }
      const token = tokens[sequence % tokens.length];
      sequence += 1;
      const started = Date.now();
      const body = JSON.stringify({ clientId: `load-${sequence}`, body: `t:${started}` });
      request("POST", `/v1/widget/${key}/messages`, token, body)
        .then(({ status }) => {
          if (status === 201) {
            sent += 1;
            sendTimes.push(Date.now() - started);
          } else {
            failed += 1;
            count(errors, `send status ${status}`);
          }
        })
        .catch((error: Error) => {
          failed += 1;
          count(errors, error.message);
        });
    },
    Math.max(1, 1000 / RATE),
  );
});
await imagesFinished;
// Let the last deliveries arrive.
await new Promise((resolve) => setTimeout(resolve, 3000));

const delivered = [...latencies].sort((a, b) => a - b);
const sends = [...sendTimes].sort((a, b) => a - b);
const imagesDone = [...imageTimes].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    streamsRequested: STREAMS,
    streamsOpen: open,
    visitorsMs,
    streamsMs,
    rate: RATE,
    seconds: SECONDS,
    sent,
    failed,
    unfinished: sequence - sent - failed,
    delivered: delivered.length,
    deliveryMs: {
      p50: percentile(delivered, 0.5),
      p95: percentile(delivered, 0.95),
      p99: percentile(delivered, 0.99),
      max: delivered.at(-1) ?? null,
    },
    sendMs: { p50: percentile(sends, 0.5), p95: percentile(sends, 0.95) },
    imageRate: IMAGE_RATE,
    imageStatuses,
    imageMs: { p50: percentile(imagesDone, 0.5), p95: percentile(imagesDone, 0.95) },
    closes,
    errors,
  }),
);
process.exit(0);
