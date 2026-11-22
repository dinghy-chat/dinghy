import { beforeEach, expect, test, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("expo/fetch", () => ({ fetch: fetchMock }));

import { DinghyApi } from "./api.ts";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      days: 30,
      timeZone: "Europe/Paris",
      started: 0,
      startedByTeam: 0,
      closed: 0,
      answered: 0,
      firstReply: { medianSeconds: null, p90Seconds: null, fast: 0 },
      previous: { started: 0, firstReply: { medianSeconds: null, fast: 0 } },
      perDay: [],
      repliers: [],
      hours: [],
      labels: [],
    }),
  });
});

test("analytics stays inside the signed-in workspace and sends the selected period", async () => {
  const api = new DinghyApi({
    origin: "https://dinghy.example",
    session: "dinghy.session=secret",
    operator: { id: "operator-1", name: "Ada" },
    workspace: { id: "workspace-1", name: "Support" },
  });

  await api.analytics(30, "Europe/Paris");

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "https://dinghy.example/v1/operator/workspaces/workspace-1/analytics?days=30&tz=Europe%2FParis",
  );
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    credentials: "omit",
    headers: {
      Cookie: "dinghy.session=secret",
      Origin: "https://dinghy.example",
    },
  });
});
