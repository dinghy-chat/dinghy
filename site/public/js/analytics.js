// Page views, clicks and session replays on dinghy.chat go to Dinghy's PostHog project, in the EU.
// PostHog's cookie is on dinghy.chat and its subdomains, so the cloud app continues the same visit.
// PostHog's own script reads this stub's `_i` list when it loads, so the site needs no inline snippet.
const HOST = "https://eu.i.posthog.com";

window.posthog = Object.assign([], {
  capture: (...args) => window.posthog.push(["capture", ...args]),
  people: [],
  _i: [
    [
      "phc_ktU9amrfggazFmzQgjR6oikS6eEbY45GarENts85wF2E",
      {
        api_host: HOST,
        person_profiles: "identified_only",
        disable_surveys: true,
      },
      "posthog",
    ],
  ],
});
const script = document.createElement("script");
script.src = `${HOST.replace(".i.posthog.com", "-assets.i.posthog.com")}/static/array.js`;
script.async = true;
script.crossOrigin = "anonymous";
document.head.append(script);

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element && event.target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;
  const target = new URL(link.href);
  if (target.origin === "https://app.dinghy.chat" && target.pathname === "/signup") {
    window.posthog.capture("cloud signup clicked", { page_path: location.pathname });
  }
  if (
    target.origin === location.origin &&
    target.pathname === "/docs/self-hosting" &&
    location.pathname !== target.pathname
  ) {
    window.posthog.capture("self-host guide clicked", { page_path: location.pathname });
  }
});
