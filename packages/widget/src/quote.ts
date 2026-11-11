/** A quoted message as the server shows it. Its `id` is null when that message was deleted. */
export interface Quote {
  id: string | null;
  /** The author's name as this side shows it. Null for the visitor's own message in the widget. */
  authorName: string | null;
  fromVisitor: boolean;
  /** Its first words, on one line, without Markdown marks. */
  excerpt: string;
  hasImage: boolean;
}

/**
 * What a quote shows in place of its words: that the message was deleted, or that it was an image.
 * Null when it shows its words. The widget, the operator app and the emails each have a text under
 * both keys, so this one rule serves them all.
 */
export const quoteStandIn = (quote: Quote): "quoteDeleted" | "quoteImage" | null =>
  quote.id === null ? "quoteDeleted" : quote.excerpt === "" && quote.hasImage ? "quoteImage" : null;
