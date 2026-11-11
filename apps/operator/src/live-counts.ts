import { useEffect, useState } from "react";
import { getWaiting, type WorkspaceApi } from "./api.ts";
import { useLatestLoad } from "./load.ts";

/** How often the other workspaces' waiting counts load again while this tab shows. */
const WAITING_EVERY_MS = 60_000;
/** How often the sidebar asks how many people are on the site. */
const LIVE_COUNT_EVERY_MS = 30_000;

/**
 * Each other workspace's waiting count, for the switcher, which has no stream of theirs here. It
 * loads when the tab shows and every minute while it does. The current workspace's count comes
 * from its own list.
 */
export function useWaitingBy(visible: boolean): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const load = useLatestLoad(async () => {
    const { workspaces } = await getWaiting();
    setCounts(Object.fromEntries(workspaces.map((one) => [one.workspaceId, one.waiting])));
  });
  useEffect(() => {
    if (!visible) return;
    load();
    const timer = setInterval(load, WAITING_EVERY_MS);
    return () => clearInterval(timer);
  }, [load, visible]);
  return counts;
}

/** The tabs of the site open now, read every 30 seconds while this tab shows. Null when unknown. */
export function useLiveCount(api: WorkspaceApi, visible: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const read = () => {
      api.liveCount().then(
        (answer) => {
          if (!stopped) setCount(answer.count);
        },
        () => {},
      );
    };
    read();
    const timer = setInterval(read, LIVE_COUNT_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, visible]);
  return count;
}
