export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reports whether the element is on screen in a tab the visitor can see. */
export function watchVisibility(element, onChange, threshold = 0) {
  let intersecting = false;
  const report = () => onChange(intersecting && !document.hidden);
  const observer = new IntersectionObserver(
    ([entry]) => {
      intersecting = entry.isIntersecting;
      report();
    },
    { threshold },
  );
  observer.observe(element);
  document.addEventListener("visibilitychange", report);
}

/** Calls frame(seconds, step) on each animation frame, only while the element is visible. */
export function animateWhileVisible(element, frame) {
  let request = 0;
  let last = 0;
  let seconds = 0;
  const tick = (now) => {
    const step = Math.min(Math.max(now - last, 0) / 1000, 0.1);
    last = now;
    seconds += step;
    frame(seconds, step);
    request = requestAnimationFrame(tick);
  };
  watchVisibility(element, (visible) => {
    cancelAnimationFrame(request);
    if (!visible) return;
    last = performance.now();
    request = requestAnimationFrame(tick);
  });
}

/** Returns a sleep function that does not finish while the element is hidden. */
export function sleeperFor(element, threshold) {
  let visible = false;
  let waiting = [];
  watchVisibility(
    element,
    (now) => {
      visible = now;
      if (!visible) return;
      for (const resume of waiting) resume();
      waiting = [];
    },
    threshold,
  );
  return async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (!visible) await new Promise((resolve) => waiting.push(resolve));
  };
}

/** Calls the function after the page width changes and settles. */
export function onWidthChange(callback) {
  let width = innerWidth;
  let timer = 0;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (innerWidth === width) return;
      width = innerWidth;
      callback();
    }, 200);
  });
}
