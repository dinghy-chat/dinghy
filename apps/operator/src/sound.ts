// A short, soft two-note chime for a visitor's new message, made with the Web Audio API, so the app
// ships no sound file. The setting is per device, and on until someone turns it off.

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

/** Two notes, a fifth apart, that fade out. At most one chime every 2 seconds. */
export function chime(): void {
  if (!soundOn() || audio === null || audio.state !== "running") return;
  if (Date.now() - lastPlayed < GAP_MS) return;
  lastPlayed = Date.now();
  const start = audio.currentTime;
  for (const [frequency, at] of [
    [784, 0],
    [1175, 0.13],
  ] as const) {
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0, start + at);
    volume.gain.linearRampToValueAtTime(0.08, start + at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.45);
    tone.connect(volume).connect(audio.destination);
    tone.start(start + at);
    tone.stop(start + at + 0.5);
  }
}
