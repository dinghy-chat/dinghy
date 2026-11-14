# Capacity measurements

The target is 1,000 concurrent streams with the full stack under 4 GB.

## 2026-11-06: the full install on a real CX23

This is the real install from `compose.yaml`, in the `all` role, so one process runs the web server and the worker. It ran on one Hetzner CX23 (2 shared vCPUs, 4 GB) in Falkenstein, with the 4 GB limit from `apps/server/load/compose.capacity.yaml`. A second CX23 in the same location generated the load, over the network with no TLS.

Each message from a visitor also made one web push alert, which the worker encrypted and sent to a stand-in service on the server. Each upload was a 12-megapixel JPEG of 3.9 MB, which the server decodes and encodes again. Images stayed in the local volume. Memory is the highest sum of the services across samples, with about 185 MB when idle.

| Streams | Messages per second | Uploads per second | Delivery p50 | Delivery p99 | Failed sends | Upload p95 | Uploads refused | Peak memory |
|---|---|---|---|---|---|---|---|---|
| 1,000 | 20 | 0 | 25 ms | 146 ms | 0 | | | 278 MB |
| 1,000 | 50 | 0 | 32 ms | 227 ms | 0 | | | 316 MB |
| 1,000 | 100 requested, about 90 reached | 0 | 8.9 s | 14.7 s | 0 | | | 358 MB |
| 1,000 | 5 | 0.5 | 26 ms | 149 ms | 0 | 614 ms | 0 | 324 MB |
| 1,000 | 5 | 1 | 27 ms | 240 ms | 0 | 679 ms | 0 | 310 MB |
| 1,000 | 5 | 2 | 31 ms | 286 ms | 0 | 711 ms | 0 | 355 MB |
| 1,000 | 5 | 3 | 37 ms | 300 ms | 0 | 979 ms | 23 of 179 | 385 MB |
| 1,000 | 5 | 4 | 39 ms | 330 ms | 0 | 1.07 s | 87 of 239 | 374 MB |
| 1,000 | 20 | 1, for 120 s | 27 ms | 260 ms | 0 | 759 ms | 0 | 370 MB |
| 5,000 | 20 | 1 | 30 ms | 628 ms | 0 | 955 ms | 0 | 539 MB |

Results:

- One CX23 runs the whole product. The peak stayed under 600 MB in every step, so memory is not the limit. A CX33 is not needed for this load.
- Chat stays clean at 50 messages per second in one workspace. This is the same limit as the earlier run, now with the worker in the same process. At 100 requested, about 90 per second went through and delivery fell behind. When the send phase ended 3 seconds before the count, 4,709 of 5,398 messages had arrived, so that step does not show whether the rest arrived later.
- The worker kept up in every step up to 50 messages per second, and finished its backlog within 1 second of the end. In the 100 requested step, 3,568 alerts were waiting at the end, and it finished them in 29 seconds. Every alert was sent.
- The server handles about 2.6 large images per second. Above that it refuses the extra uploads with a 503, as it should, and chat delivery stays clean.

Not measured: TLS on the server, a real push service, email, images in S3, or many workspaces.

An earlier run of the 4-uploads step reported failed message sends. The load generator caused them, because a refused upload closed a connection that sends shared. Uploads now have their own connections, and the table comes from the rerun.

To repeat this, run the check on the load machine, with the image already on the server:

```sh
DOCKER_HOST=ssh://root@<server> CAPACITY_HOST=<server> \
  scripts/capacity-check.sh <image> <streams> <messages per second> <seconds> <uploads per second>
```

The nightly job runs `scripts/capacity-check.sh <image> 1000 20 60 1` on a GitHub runner. The services' limits total 4 GB. It fails if a send or an upload fails, a message or an alert is lost, or a service reaches its limit and is killed.

## 2026-11-05: a real CX23

Postgres, Valkey and the web role ran on one Hetzner CX23 (2 shared vCPUs, 4 GB) in Falkenstein. A second CX23 in the same location generated the load, over the network with no TLS. All streams were in one workspace, and each message went to one stream, the sender's own. Each step sent messages for 60 seconds. Memory is the highest sum of the three services across samples taken every 3 seconds.

| Streams | Messages per second | Delivery p50 | Delivery p99 | Failed sends | Peak memory |
|---|---|---|---|---|---|
| 1,000 | 5 | 32 ms | 55 ms | 0 | 321 MB |
| 5,000 | 20 | 30 ms | 48 ms | 0 | 470 MB |
| 10,000 | 20 | 33 ms | 54 ms | 0 | 648 MB |
| 20,000 | 20 | 30 ms | 55 ms | 0 | 1,031 MB |
| 1,000 | 50 | 27 ms | 49 ms | 0 | 337 MB |
| 1,000 | 100 | 35 ms | 1.5 s | 0 | 370 MB |
| 1,000 | 200 requested, about 106 reached | 19.8 s | 40.9 s | 0 | 561 MB |

Results:

- The target passes. One CX23 held 20,000 open streams in about 1 GB. Opening them took 70 seconds, about 290 per second, with the CPU near its limit.
- The limit is message rate, not open streams. Delivery is clean at 50 messages per second in one workspace, degrades at 100, and saturates at about 106. Sends in one workspace take turns on the workspace row lock by design.
- For scale, 50 messages per second is 4.3 million a day. A CX33 is not needed for chat load.

This did not measure images, the worker, TLS on the server, or traffic across many workspaces, which do not share a row lock. The section above adds images and the worker.

## 2026-11-05: through Cloudflare's proxy

One stream ran through a proxied hostname for 180 idle seconds, on Cloudflare's Free plan with SSL mode Full. It stayed open, received 7 heartbeats, and delivered a message over the same connection 237 ms after the send. Cloudflare drops an idle proxied connection after 125 seconds with no data, per its docs on November 9, 2026, so the 25-second heartbeat is what holds it open.

## 2026-11-05: local run

An earlier run on one 16-CPU machine, with all three services sharing 2 CPUs, reached higher rates than the CX23: 200 messages per second were clean, and it saturated at about 390. Use the CX23 numbers.

## How to repeat this

On the server, with a firewall limiting port 3100 to the load machine:

```sh
LOAD_HOST=<hostname> docker compose -f apps/server/load/compose.yaml -f apps/server/load/compose.remote.yaml up -d --wait
docker run --rm --network dinghy-load_default -v "$PWD:/repo:ro" -w /repo node:24-slim \
  node apps/server/load/setup.ts postgres://postgres@postgres:5432/postgres https://load.example.com
```

The last line prints a public key. On the load machine, run `apps/server/load/run.ts`, which needs only Node:

```sh
node run.ts http://<server>:3100 <public key> https://load.example.com <streams> <messages per second> <seconds>
```
