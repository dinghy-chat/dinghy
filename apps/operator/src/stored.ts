// Per-browser choices in localStorage. Storage throws in some private windows and with blocked site
// data. Then the choice lives in memory, so it lasts until the page reloads.

const memory = new Map<string, string>();

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

/** Saves a value, or with null removes it. */
export function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}
