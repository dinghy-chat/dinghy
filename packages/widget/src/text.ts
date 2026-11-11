// Every string the visitor reads has a key, so a locale can be added later.

// Apart from the others, so the loader does not bundle every string.
export const LAUNCHER_LABEL = "Open chat";

const en = {
  title: "Chat with us",
  teamOnline: "We are online",
  teamAway: "We are away. Leave a message and we will reply here.",
  waiting: "We will reply here.",
  sceneSending: "Sending your message",
  newReply: "New reply",
  close: "Close chat",
  blocked: "You cannot send messages in this chat.",
  notHere: "This chat is not available on this site.",
  empty: "Send us a message. We will reply here.",
  inputLabel: "Your message",
  inputPlaceholder: "Write a message...",
  send: "Send",
  sending: "Sending...",
  failed: "Not sent. Select to try again.",
  reconnecting: "Connection lost. Trying again...",
  attach: "Attach an image",
  emoji: "Add an emoji",
  imageAlt: "An image in this conversation",
  imageSending: "Sending an image...",
  imageTooLarge: "This image is over 5 MB.",
  imageWrongType: "Send a PNG, JPEG or WebP image.",
  imageFailed: "That image could not be sent. Send a PNG, JPEG or WebP under 16 megapixels.",
  imageView: "View the image at full size",
  imageRemoved: "Image removed after 12 months",
  imageNoRoom: "This chat cannot take more images right now.",
  emailLabel: "Your email, so we can reply if you leave",
  emailSave: "Save",
  emailSaved: "Thanks. We will use this email if you leave.",
  emailInvalid: "Enter a valid email.",
  emailFailed: "Not saved. Try again.",
  poweredBy: "Powered by Dinghy",
};

export type TextId = keyof typeof en;

export function t(id: TextId): string {
  return en[id];
}
