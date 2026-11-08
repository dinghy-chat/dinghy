import { reducedMotion } from "./motion.js";

const HEADER_OFFSET = 84;

/** Same-page links scroll smoothly, leave the address alone, and move keyboard focus. */
function followSamePageLinks() {
  document.addEventListener("click", (event) => {
    // A modified click opens a new tab or window, as the browser normally does.
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.origin !== location.origin || link.pathname !== location.pathname) return;
    const target = link.hash ? document.querySelector(link.hash) : document.body;
    if (!target) return;
    event.preventDefault();
    const top = link.hash ? target.getBoundingClientRect().top + scrollY - HEADER_OFFSET : 0;
    scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  });
}

/** The header is yellow over the hero and white over the rest of the page. */
function flipHeaderPastHero(header) {
  const hero = document.querySelector("[data-hero]");
  const observer = new IntersectionObserver(
    ([entry]) => header.classList.toggle("is-past-hero", !entry.isIntersecting),
    { rootMargin: "-90px 0px 0px" },
  );
  observer.observe(hero);
}

const header = document.querySelector(".site-header");
followSamePageLinks();
flipHeaderPastHero(header);
