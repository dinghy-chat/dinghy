import { useEffect } from "preact/hooks";
import { type Client, pageAddress, pageTitle } from "./client.ts";

const TITLE_WAIT_MS = 500;

// A single-page site changes its address with the History API, which fires no event of its own.
const NAVIGATED = "dinghy:navigated";
let watchingHistory = false;
function watchHistory() {
  if (watchingHistory) return;
  watchingHistory = true;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      original.apply(this, args);
      dispatchEvent(new Event(NAVIGATED));
    };
  }
}

/**
 * Reports the page the visitor is on, for operators, when the chat loads and when the address
 * changes. `active` is true only for a visitor who has chatted, so someone who never used the chat
 * sends nothing.
 */
export function usePageReports(client: Client, token: string | null, active: boolean) {
  useEffect(() => {
    if (token === null || !active) return;
    let last = "";
    const report = () => {
      const address = pageAddress();
      const title = pageTitle();
      if (`${address} ${title}` === last) return;
      last = `${address} ${title}`;
      client.reportPage(token, address, title).catch(() => {
        // Only a detail for operators. The next change of address tries again.
        last = "";
      });
    };
    // A single-page app sets its new title a moment after it changes the address.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const navigated = () => {
      clearTimeout(timer);
      timer = setTimeout(report, TITLE_WAIT_MS);
    };
    watchHistory();
    report();
    addEventListener(NAVIGATED, navigated);
    addEventListener("popstate", navigated);
    return () => {
      clearTimeout(timer);
      removeEventListener(NAVIGATED, navigated);
      removeEventListener("popstate", navigated);
    };
  }, [active, client, token]);
}
