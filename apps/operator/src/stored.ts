// Per-browser choices in localStorage. Storage throws in some private windows and with blocked site
// data, so a read then gives null and a write is skipped: the choice lasts until the page reloads.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves a value, or with null removes it. */
export function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // See the note at the top.
  }
}
