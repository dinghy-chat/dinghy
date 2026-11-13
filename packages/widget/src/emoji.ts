// The emoji picker's choices, shared by the widget and the operator app. Each is one code point
// with an emoji look by default, so spreading the string splits it and no font draws it as text.
export const EMOJIS = [..."😀😂😊😍🙂😉😎🤔😅😢😮😴🙏👍👎👋👏🙌💪💙🎉🔥✨✅❌👀💡🚀📦⏳☕🎁"];

/** Phosphor Icons (MIT) Smiley, regular weight: the picker's button. */
export const SMILEY_ICON =
  "M128,24A104,104,0,1,0,232,128,104,104,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88,88,0,0,1,128,216ZM80,108a12,12,0,1,1,12,12A12,12,0,0,1,80,108Zm96,0a12,12,0,1,1-12-12A12,12,0,0,1,176,108Zm-1,48c-10,18-27,28-47,28s-37-10-47-28a8,8,0,1,1,14-8c7,13,19,20,33,20s26-7,33-20a8,8,0,0,1,14,8Z";

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
