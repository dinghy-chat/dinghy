// Every string the visitor reads has a key, so a locale can be added later.

// Apart from the others, so the loader does not bundle every string.
export const LAUNCHER_LABEL = "Open chat";
/** The chat's title, which the label launcher shows too. */
export const DEFAULT_TITLE = "Chat with us";

const en = {
  title: DEFAULT_TITLE,
  teamOnline: "Online",
  teamAway: "Away, we reply here and by email",
  replyMinutes: "Usually replies in {n} min",
  replyHours: "Usually replies in {n} h",
  waiting: "We will reply here",
  sceneSending: "Sending...",
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
  reconnecting: "Reconnecting...",
  attach: "Attach an image",
  attachFile: "Attach an image or a file",
  emoji: "Add an emoji",
  imageAlt: "An image in this conversation",
  imageSending: "Sending an image...",
  imageTooLarge: "This image is over 5 MB.",
  imageWrongType: "Send a PNG, JPEG or WebP image.",
  imageFailed: "That image could not be sent. Send a PNG, JPEG or WebP under 16 megapixels.",
  imageView: "View the image at full size",
  imageRemoved: "Image removed after 12 months",
  noRoom: "This chat cannot take more files right now.",
  fileSending: "Sending a file...",
  fileTooLarge: "This file is over 10 MB.",
  fileWrongType:
    "Send an image, or a PDF, TXT, CSV, LOG, JSON, ZIP, DOC, DOCX, XLS, XLSX, PPT, PPTX, ODT, ODS, MP4 or MOV file.",
  fileRemoved: "File removed after 12 months",
  emailTitle: "Get replies by email",
  emailAfterFirst: "We'll email you when we reply, if you have left the page.",
  emailBeforeFirst: "Leave your email so we can reply",
  emailLabel: "Your email",
  emailPlaceholder: "name@example.com",
  emailSave: "Save",
  emailSavedTo: "We'll email replies to {email}",
  emailInvalid: "Enter a valid email.",
  emailFailed: "Not saved. Try again.",
  poweredBy: "Powered by Dinghy",
  closed: "This conversation is closed. Write to us again any time.",
  reopened: "Conversation reopened",
  reply: "Reply",
  cancelReply: "Cancel the reply",
  you: "You",
  quoteDeleted: "Original message deleted",
  quoteImage: "Image",
  messageDeleted: "Message deleted",
  botTyping: "{name} is typing…",
};

export type TextId = keyof typeof en;

export function t(id: TextId): string {
  return en[id];
}
