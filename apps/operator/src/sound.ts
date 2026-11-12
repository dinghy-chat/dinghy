// The chime for a visitor's new message: the widget's tone and its 2-second gap, on this app's own
// audio. The setting is per device, and on until someone turns it off.

import { chime as playChime } from "../../../packages/widget/src/sound.ts";
import { readStored, store } from "./stored.ts";

const KEY = "dinghy:sound";

/** Without storage, the sound stays on. */
export function soundOn(): boolean {
  return readStored(KEY) !== "off";
}

export function setSoundOn(on: boolean): void {
  store(KEY, on ? null : "off");
}

let audio: AudioContext | null = null;

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

/** The chime, while the setting is on. */
export function chime(): void {
  if (soundOn()) playChime(audio);
}
