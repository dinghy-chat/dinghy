// The emoji picker's choices, shared by the widget and the operator app. Each is one code point
// with an emoji look by default, so spreading the string splits it and no font draws it as text.
export const EMOJIS = [..."😀😂😊😍🙂😉😎🤔😅😢😮😴🙏👍👎👋👏🙌💪💙🎉🔥✨✅❌👀💡🚀📦⏳☕🎁"];

/** Phosphor Icons (MIT) Smiley, regular weight: the picker's button. */
export const SMILEY_ICON =
  "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM80,108a12,12,0,1,1,12,12A12,12,0,0,1,80,108Zm96,0a12,12,0,1,1-12-12A12,12,0,0,1,176,108Zm-1.07,48c-10.29,17.79-27.4,28-46.93,28s-36.63-10.2-46.92-28a8,8,0,1,1,13.84-8c7.47,12.91,19.21,20,33.08,20s25.61-7.1,33.07-20a8,8,0,0,1,13.86,8Z";

/**
 * Puts an emoji where the caret is, or over the selected text, and returns the new value. The
 * caret goes after the emoji once the caller has rendered that value.
 */
export function insertEmoji(field: HTMLTextAreaElement | HTMLInputElement, emoji: string): string {
  const { value, maxLength } = field;
  const start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? value.length;
  const next = value.slice(0, start) + emoji + value.slice(end);
  // A full field stays as it is, as it does when someone types.
  if (maxLength > 0 && next.length > maxLength) return value;
  const caret = start + emoji.length;
  requestAnimationFrame(() => {
    field.focus();
    field.setSelectionRange(caret, caret);
  });
  return next;
}
