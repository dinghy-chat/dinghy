import { useEffect } from "react";
import { t } from "./text.ts";

const ICON = "/assets/icon.svg";
/** The favicon's size in the drawing, and its red dot, as fractions of it. */
const SIZE = 64;
const DOT = { x: 0.76, y: 0.24, radius: 0.22, ring: 0.06 };

/** The app's icon with a red dot in its corner, drawn once, or null if the browser cannot. */
let dotted: Promise<string | null> | null = null;
function dottedIcon(): Promise<string | null> {
  dotted ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const context = canvas.getContext("2d");
      if (context === null) return resolve(null);
      context.drawImage(image, 0, 0, SIZE, SIZE);
      // A white ring keeps the dot apart from the navy icon behind it.
      context.beginPath();
      context.arc(DOT.x * SIZE, DOT.y * SIZE, (DOT.radius + DOT.ring) * SIZE, 0, 2 * Math.PI);
      context.fillStyle = "#fff";
      context.fill();
      context.beginPath();
      context.arc(DOT.x * SIZE, DOT.y * SIZE, DOT.radius * SIZE, 0, 2 * Math.PI);
      context.fillStyle = "#e5352b";
      context.fill();
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => resolve(null);
    image.src = ICON;
  });
  return dotted;
}

function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link !== null && link.getAttribute("href") !== href) link.href = href;
}

/**
 * Shows the conversations waiting for this operator outside the page: the count in the tab's title,
 * a red dot on the favicon, as a number at 16 pixels is hard to read, and the count on the
 * installed app's icon where the system supports it.
 */
export function useWaitingBadge(waiting: number) {
  useEffect(() => {
    let current = true;
    document.title = waiting > 0 ? `(${waiting}) ${t("appName")}` : t("appName");
    if (waiting > 0) {
      void dottedIcon().then((href) => {
        if (current && href !== null) setFavicon(href);
      });
    } else {
      setFavicon(ICON);
    }
    // Only an installed app shows it, and a browser may refuse. Neither is worth a message.
    if (waiting > 0) navigator.setAppBadge?.(waiting).catch(() => {});
    else navigator.clearAppBadge?.().catch(() => {});
    return () => {
      current = false;
    };
  }, [waiting]);
  // Only on unmount, so a change of count does not swap the favicon twice.
  useEffect(
    () => () => {
      document.title = t("appName");
      setFavicon(ICON);
      navigator.clearAppBadge?.().catch(() => {});
    },
    [],
  );
}
