import type { DinghyApi, QueuedCall, WidgetContext } from "./shared.ts";

// Apart from shared.ts, so the npm package's types do not declare the loader's private global.
declare global {
  var __dinghy: WidgetContext | undefined;
  /** Before the loader runs, a page can queue calls as `Dinghy = { q: [["open"]] }`. */
  var Dinghy: DinghyApi | { q?: QueuedCall[] } | undefined;
}
