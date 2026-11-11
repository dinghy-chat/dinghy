/**
 * Moves between the app's screens without loading the page again, so the sky and the sea stay in
 * place while the card changes. The app listens for this event, loads the account again and then
 * shows the new address.
 */
export const NAVIGATE_EVENT = "dinghy:navigate";

/** Set by a screen with unsaved changes, which runs the move only if the operator lets it. */
let leaveGuard: ((move: () => void) => void) | null = null;

export function setLeaveGuard(guard: typeof leaveGuard) {
  leaveGuard = guard;
}

/** Runs a move to another screen, view or page, once no unsaved change stands in the way. */
export function leave(move: () => void) {
  if (leaveGuard === null) move();
  else leaveGuard(move);
}

export function navigate(path: string) {
  leave(() => {
    const url = new URL(path, location.origin);
    // A link to another site, such as Stripe, leaves the app.
    if (url.origin !== location.origin) {
      location.assign(url.href);
      return;
    }
    history.pushState(null, "", `${url.pathname}${url.search}`);
    dispatchEvent(new Event(NAVIGATE_EVENT));
  });
}
