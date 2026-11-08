import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Runs one load at a time, and once more if it was asked again meanwhile. Canceling a slow load for
 * each new event would mean a busy workspace never finishes one.
 */
export function useLatestLoad(load: () => Promise<void>): () => void {
  const latest = useRef(load);
  // After the render commits, because a render that React throws away must not change it.
  useLayoutEffect(() => {
    latest.current = load;
  });
  const state = useRef({ running: false, again: false });
  return useCallback(() => {
    const run = state.current;
    if (run.running) {
      run.again = true;
      return;
    }
    run.running = true;
    void (async () => {
      do {
        run.again = false;
        await latest.current().catch(() => {
          // The next change or reconnect loads this again.
        });
      } while (run.again);
      run.running = false;
    })();
  }, []);
}
