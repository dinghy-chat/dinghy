export type ComposerAction = { label: string; run(): void };

export function openComposerMenu(_actions: readonly ComposerAction[], openSheet: () => void) {
  openSheet();
}
