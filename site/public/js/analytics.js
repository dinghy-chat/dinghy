// Page views, clicks and session replays on dinghy.chat go to Dinghy's PostHog project, in the EU.
// PostHog's cookie is on dinghy.chat and its subdomains, so the cloud app continues the same visit.
// PostHog's own script reads this stub's `_i` list when it loads, so the site needs no inline snippet.
const HOST = "https://eu.i.posthog.com";

window.posthog = Object.assign([], {
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
