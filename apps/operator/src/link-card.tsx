/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import {
  type LinkCard,
  type LinkPreviewOptions,
  linkHost,
  useLinkPreviewWith,
} from "./link-preview.ts";
import { t } from "./text.ts";

/** The composer's link card, on this app's React. */
export const useLinkPreview = (options: LinkPreviewOptions) =>
  useLinkPreviewWith({ useEffect, useRef, useState }, options);

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
        {link.image !== null && (
          <img src={link.image.url} alt="" loading="lazy" onError={onImageError} />
        )}
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
