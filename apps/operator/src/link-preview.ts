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
 * request counts. A link in `removedLinks` gets no card. A request that failed, as on a busy server,
 * asks again at the next edit.
 */
export function createLinkPreviews(
  ask: (url: string) => Promise<LinkPreview | null>,
  show: (card: LinkPreview | null) => void,
) {
  let draft = "";
  let link: string | null = null;
  let hasFailed = false;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    update(text: string, isActive: boolean, removedLinks: readonly string[]) {
      const isEdit = text !== draft;
      // Several characters at once are a paste.
      const isPaste = text.length - draft.length > 1;
      draft = text;
      const found = isActive ? firstBareLink(text) : null;
      const next = found !== null && removedLinks.includes(found) ? null : found;
      if (next === link && !(hasFailed && isEdit)) return;
      link = next;
      hasFailed = false;
      latest += 1;
      clearTimeout(timer);
      show(null);
      if (next === null) return;
      const request = latest;
      const fetch = () =>
        ask(next).then(
          (card) => {
            if (request === latest) show(card);
          },
          () => {
            if (request === latest) hasFailed = true;
          },
        );
      timer = setTimeout(fetch, isPaste ? 0 : TYPING_PAUSE_MS);
    },
    stop: () => clearTimeout(timer),
  };
}

/** The React hooks that `useLinkPreviewWith` needs. Each app passes its own, as each bundles its React. */
export interface ReactHooks {
  useState<S>(initial: () => S): [S, (next: S) => void];
  useEffect(effect: () => void, deps: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
}

const NO_LINKS: readonly string[] = [];

export interface LinkPreviewOptions {
  ask: (url: string) => Promise<LinkPreview | null>;
  draft: string;
  isActive: boolean;
  removedLinks?: readonly string[] | undefined;
  setRemovedLinks: (links: string[]) => void;
}

/**
 * The card of the draft's first bare link while `isActive`, and `remove`, which adds its link to
 * `removedLinks`. The draft keeps them, so a removed card stays away until the draft empties.
 */
export function useLinkPreviewWith(
  { useEffect, useRef, useState }: ReactHooks,
  { ask, draft, isActive, removedLinks = NO_LINKS, setRemovedLinks }: LinkPreviewOptions,
) {
  const [card, setCard] = useState<LinkPreview | null>(() => null);
  const latestAsk = useRef(ask);
  latestAsk.current = ask;
  const [previews] = useState(() => createLinkPreviews((url) => latestAsk.current(url), setCard));
  useEffect(
    () => previews.update(draft, isActive, removedLinks),
    [previews, draft, isActive, removedLinks],
  );
  useEffect(() => previews.stop, [previews]);
  useEffect(() => {
    if (draft === "" && removedLinks.length > 0) setRemovedLinks([]);
  }, [draft, removedLinks, setRemovedLinks]);
  return {
    card,
    remove: () => {
      if (card !== null) setRemovedLinks([...removedLinks, card.url]);
    },
  };
}
