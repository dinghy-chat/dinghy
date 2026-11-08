const RESET_MS = 2000;

/** The text of a code block. The prompts are drawn by CSS, so they are not part of it. */
const commandsIn = (block) => block.textContent;

/** Selects the code, so a visitor can copy it by hand when the clipboard is refused. */
function select(block) {
  const range = document.createRange();
  range.selectNodeContents(block);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Copy buttons: each copies the code block named by data-copy, and says so. */
export function startCopyButtons() {
  const status = document.querySelector("[data-copy-status]");
  for (const button of document.querySelectorAll("[data-copy]")) {
    const block = document.getElementById(button.dataset.copy);
    const label = button.querySelector("[data-copy-label]");
    let timer = 0;
    button.addEventListener("click", async () => {
      let message = "Copied";
      try {
        await navigator.clipboard.writeText(commandsIn(block));
      } catch {
        select(block);
        message = "Selected";
      }
      label.textContent = message;
      button.classList.add("is-done");
      if (status) status.textContent = message === "Copied" ? "Copied to the clipboard" : "Selected. Press Ctrl+C or Cmd+C to copy";
      clearTimeout(timer);
      timer = setTimeout(() => {
        label.textContent = "Copy";
        button.classList.remove("is-done");
      }, RESET_MS);
    });
  }
}
