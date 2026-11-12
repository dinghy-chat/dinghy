import { useEffect } from "react";
import { t } from "./text.ts";

const ICON = "/assets/icon.svg";
/** The favicon's drawing size. */
const ICON_SIZE_PX = 64;
/**
 * The red dot, as fractions of the icon. It and its ring stay 0.04 inside the edge, as a browser
 * can round the icon's corners and would cut it.
 */
const DOT = { x: 0.78, y: 0.22, radius: 0.13, ring: 0.05 };
/** As --red in app.css, with a white ring that keeps it apart from the navy icon. */
const DOT_COLOR = "#e5352b";
const DOT_RING_COLOR = "#fff";

/** The app's icon with a red dot in its corner, drawn once, or null if the browser cannot. */
let dotted: Promise<string | null> | null = null;
function dottedIcon(): Promise<string | null> {
  dotted ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ICON_SIZE_PX;
      const context = canvas.getContext("2d");
      if (context === null) return resolve(null);
      context.drawImage(image, 0, 0, ICON_SIZE_PX, ICON_SIZE_PX);
      const circle = (radius: number, color: string) => {
        context.beginPath();
        context.arc(
          DOT.x * ICON_SIZE_PX,
          DOT.y * ICON_SIZE_PX,
          radius * ICON_SIZE_PX,
          0,
          2 * Math.PI,
        );
        context.fillStyle = color;
        context.fill();
      };
      circle(DOT.radius + DOT.ring, DOT_RING_COLOR);
      circle(DOT.radius, DOT_COLOR);
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
    // Only an installed app shows the app badge, and a browser may refuse. Neither is worth a message.
    if (waiting > 0) {
      document.title = `(${waiting}) ${t("appName")}`;
      void dottedIcon().then((href) => {
        if (current && href !== null) setFavicon(href);
      });
      navigator.setAppBadge?.(waiting).catch(() => {});
    } else {
      document.title = t("appName");
      setFavicon(ICON);
      navigator.clearAppBadge?.().catch(() => {});
    }
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
