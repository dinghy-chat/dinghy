// The composer's link card, the same in the web app and the mobile app: it follows the draft's
// first bare link, asks the server for its card, and keeps the card that the reply carries.

import { firstBareLink } from "../../../packages/widget/src/markdown.ts";

/** A reply's card under its text: the page's title and thumbnail, and the link it opens. */
export interface LinkCard {
  url: string;
  title: string;
  image: { url: string; width: number; height: number } | null;
}

/** A link's card from the server, before the reply sends it back with `token`. */
export interface LinkPreview {
  url: string;
  title: string;
  image: { data: string; width: number; height: number } | null;
  token: string;
}

/** A pause in typing this long asks for the card. A paste asks at once. */
const TYPING_PAUSE_MS = 500;

/** The card as a message shows it, with the thumbnail's data in place of its address. */
export const previewCard = ({ url, title, image }: LinkPreview): LinkCard => ({
  url,
  title,
  image: image && { url: image.data, width: image.width, height: image.height },
});

/** What a reply sends back so its card goes out with it. */
export const sentPreview = (preview: LinkPreview) => ({
  token: preview.token,
  image: preview.image?.data ?? null,
});

/** The link's own hostname, never the page's claim, so a page cannot pass for another site. */
export const linkHost = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

/**
 * Follows a draft and shows the card of its first bare link, or null. Only the answer to the latest
 * request counts. A card the operator removed does not come back until the draft is sent or
 * cleared, even when `isActive` turns off for a note and back on.
 */
export function createLinkPreviews(
  ask: (url: string) => Promise<LinkPreview | null>,
  show: (card: LinkPreview | null) => void,
) {
  let link: string | null = null;
  let length = 0;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const removed = new Set<string>();
  return {
    update(draft: string, isActive: boolean) {
      // Several characters at once are a paste.
      const isPaste = draft.length - length > 1;
      length = draft.length;
      if (draft === "") removed.clear();
      const next = isActive ? firstBareLink(draft) : null;
      if (next === link) return;
      link = next;
      latest += 1;
      clearTimeout(timer);
      show(null);
      if (next === null || removed.has(next)) return;
      const request = latest;
      const fetch = () =>
        ask(next).then(
          (card) => {
            if (request === latest && !removed.has(next)) show(card);
          },
          () => undefined,
        );
      timer = setTimeout(fetch, isPaste ? 0 : TYPING_PAUSE_MS);
    },
    remove() {
      if (link !== null) removed.add(link);
      show(null);
    },
    stop: () => clearTimeout(timer),
  };
}
