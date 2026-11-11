// The widget's chime for a visitor's new message. The setting is per device, and on until someone
// turns it off.

import { playChime } from "../../../packages/widget/src/sound.ts";
import { readStored, store } from "./stored.ts";

const KEY = "dinghy:sound";
const GAP_MS = 2000;

/** Without storage, the sound stays on. */
export function soundOn(): boolean {
  return readStored(KEY) !== "off";
}

export function setSoundOn(on: boolean): void {
  store(KEY, on ? null : "off");
}

let audio: AudioContext | null = null;
let lastPlayed = 0;

/**
 * Browsers start audio only after the person clicks or types on the page, so the context starts on
 * the first click or key press, and the listeners go once it runs.
 */
export function prepareSound(): () => void {
  const start = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume().then(stop, () => {});
    } catch {
      // No Web Audio here: the app stays silent.
      stop();
    }
  };
  const stop = () => {
    removeEventListener("pointerdown", start, true);
    removeEventListener("keydown", start, true);
  };
  addEventListener("pointerdown", start, true);
  addEventListener("keydown", start, true);
  return stop;
}

/** The chime, while the setting is on, at most once every 2 seconds. */
export function chime(): void {
  if (!soundOn() || audio === null || audio.state !== "running") return;
  if (Date.now() - lastPlayed < GAP_MS) return;
  lastPlayed = Date.now();
  playChime(audio);
}
