/**
 * Moves between the app's screens without loading the page again, so the sky and the sea stay in
 * place while the card changes. The app listens for this event, loads the account again and then
 * shows the new address. Back and Forward send it too.
 */
export const NAVIGATE_EVENT = "dinghy:navigate";

/**
 * Set by a screen with unsaved changes, which runs the move only if the operator lets it, and runs
 * `stay` if they keep the screen.
 */
type LeaveGuard = (move: () => void, stay: () => void) => void;
let leaveGuard: LeaveGuard | null = null;

export function setLeaveGuard(guard: LeaveGuard | null) {
  leaveGuard = guard;
}

/** Runs a move to another screen, view or page, once no unsaved change stands in the way. */
export function leave(move: () => void, stay: () => void = () => {}) {
  if (leaveGuard === null) move();
  else leaveGuard(move, stay);
}

/** How far into this tab's history each address is, so a Back the operator cancels can return. */
const positionOf = (state: unknown): number =>
  typeof state === "object" && state !== null && "position" in state ? Number(state.position) : 0;
let position = positionOf(history.state);

/** A new address in the history, which Back leaves. */
export function pushAddress(address: string) {
  position += 1;
  history.pushState({ position }, "", address);
}

/** Changes the address in place, such as for a filter, so Back skips it. */
export function replaceAddress(address: string) {
  history.replaceState(history.state, "", address);
}

export function navigate(path: string) {
  leave(() => {
    const url = new URL(path, location.origin);
    // A link to another site, such as Stripe, leaves the app.
    if (url.origin !== location.origin) {
      location.assign(url.href);
      return;
    }
    pushAddress(`${url.pathname}${url.search}`);
    dispatchEvent(new Event(NAVIGATE_EVENT));
  });
}

/** True while the history returns to where a cancelled Back or Forward started. */
let returning = false;

addEventListener("popstate", (event) => {
  const to = positionOf(event.state);
  if (returning) {
    returning = false;
    position = to;
    return;
  }
  const from = position;
  leave(
    () => {
      position = to;
      dispatchEvent(new Event(NAVIGATE_EVENT));
    },
    () => {
      if (from === to) return;
      returning = true;
      history.go(from - to);
    },
  );
});
