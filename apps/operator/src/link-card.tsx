/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { createLinkPreviews, type LinkCard, type LinkPreview, linkHost } from "./link-preview.ts";
import { t } from "./text.ts";

/** The card of the draft's first bare link while `isActive`, and the ✕ that removes it. */
export function useLinkPreview(
  ask: (url: string) => Promise<LinkPreview | null>,
  draft: string,
  isActive: boolean,
) {
  const [card, setCard] = useState<LinkPreview | null>(null);
  const latestAsk = useRef(ask);
  latestAsk.current = ask;
  const [previews] = useState(() => createLinkPreviews((url) => latestAsk.current(url), setCard));
  useEffect(() => previews.update(draft, isActive), [previews, draft, isActive]);
  useEffect(() => previews.stop, [previews]);
  return { card, remove: previews.remove };
}

/**
 * A link's card: a thumbnail, the page's title and the link's hostname. It opens the link.
 * `onImageError` refreshes a thumbnail address that expired, as for an image.
 */
export function LinkCardView({
  link,
  onRemove,
  onImageError,
}: {
  link: LinkCard;
  onRemove?: () => void;
  onImageError?: () => void;
}) {
  return (
    <div className="link-card">
      <a href={link.url} target="_blank" rel="noopener noreferrer">
        {link.image !== null && <img src={link.image.url} alt="" onError={onImageError} />}
        <span className="link-card-text">
          <strong className="link-title">{link.title}</strong>
          {/* Cut from the left, so the end of the name, which names the site, stays. */}
          <span className="link-host">
            <bdi>{linkHost(link.url)}</bdi>
          </span>
        </span>
      </a>
      {onRemove !== undefined && (
        <button
          type="button"
          className="icon-button"
          aria-label={t("removeLinkPreview")}
          title={t("removeLinkPreview")}
          onClick={onRemove}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
