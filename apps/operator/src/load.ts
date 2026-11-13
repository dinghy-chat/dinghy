import {
  type DependencyList,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TextId } from "./text.ts";
import { failureText } from "./ui.tsx";

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

/**
 * What a load gave: its answer, or why it failed, with ways to replace it or load it again.
 * `setData` takes an update function too, for changes that may finish in any order.
 */
export interface Loaded<T> {
  data: T | null;
  failure: TextId | null;
  setData: Dispatch<SetStateAction<T | null>>;
  reload(): void;
}

/**
 * Loads on mount, and again when `deps` change or `reload` runs. A load that returns null loads
 * nothing. An answer that a newer load replaced is dropped, so a slow one never overwrites it.
 */
export function useLoad<T>(load: () => Promise<T> | null, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's list names what `load` reads.
  useEffect(() => {
    const loading = load();
    if (loading === null) return;
    let current = true;
    setFailure(null);
    loading.then(
      (next) => {
        if (current) setData(next);
      },
      (error: unknown) => {
        if (current) setFailure(failureText(error, {}, "actionFailed"));
      },
    );
    return () => {
      current = false;
    };
  }, [...deps, version]);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { data, failure, setData, reload };
}

/** A page's writes: whether one runs, and why the last one failed. */
export interface Action {
  busy: boolean;
  failure: TextId | null;
  /** Shows a failure from elsewhere on the page, or clears it with null. */
  setFailure(failure: TextId | null): void;
  /** Runs a write, then reloads the page's data. Answers whether the write worked. */
  run(work: () => Promise<unknown>): Promise<boolean>;
}

/**
 * Runs a settings page's writes: busy while one runs, its failure as a text by `byStatus`, and
 * `reload` after each one that worked.
 */
export function useAction(
  reload: () => void,
  byStatus: Partial<Record<number, TextId>> = {},
): Action {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setFailure(null);
    setBusy(true);
    try {
      await work();
      reload();
      return true;
    } catch (error) {
      setFailure(failureText(error, byStatus));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, setFailure, run };
}
