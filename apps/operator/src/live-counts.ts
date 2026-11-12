import { useEffect, useState } from "react";
import { getWaiting, type WorkspaceApi } from "./api.ts";
import { useLatestLoad } from "./load.ts";

/** How often the waiting counts load again, which a hidden tab's timers allow anyway. */
const WAITING_EVERY_MS = 60_000;
/** How often the sidebar asks how many people are on the site. */
const LIVE_COUNT_EVERY_MS = 30_000;

/**
 * Each workspace's waiting count: the others' for the switcher, which has no stream of theirs here,
 * and this one's for the badge while the tab is hidden and holds no stream. It loads when the tab
 * shows or hides, and every minute either way.
 */
export function useWaitingBy(visible: boolean): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const load = useLatestLoad(async () => {
    const { workspaces } = await getWaiting();
    setCounts(Object.fromEntries(workspaces.map((one) => [one.workspaceId, one.waiting])));
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: showing or hiding the tab asks for a load.
  useEffect(() => {
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
