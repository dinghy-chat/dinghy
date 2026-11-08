/**
 * Moves between the app's screens without loading the page again, so the sky and the sea stay in
 * place while the card changes. The app listens for this event, loads the account again and then
 * shows the new address.
 */
export const NAVIGATE_EVENT = "dinghy:navigate";

export function navigate(path: string) {
  const url = new URL(path, location.origin);
  // A link to another site, such as Stripe, leaves the app.
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  history.pushState(null, "", `${url.pathname}${url.search}`);
  dispatchEvent(new Event(NAVIGATE_EVENT));
}
