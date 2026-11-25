// Page views and clicks on dinghy.chat go to Dinghy's PostHog project, in the EU. Cookieless mode stores
// nothing in the browser: PostHog's server counts visitors with a hash that changes each day.
// PostHog's own script reads this stub's `_i` list when it loads, so the site needs no inline snippet.
const HOST = "https://eu.i.posthog.com";

window.posthog = Object.assign([], {
  people: [],
  _i: [
    [
      "phc_ktU9amrfggazFmzQgjR6oikS6eEbY45GarENts85wF2E",
      {
        api_host: HOST,
        cookieless_mode: "always",
        person_profiles: "identified_only",
        disable_session_recording: true,
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
