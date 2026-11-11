// A soft two-note chime made with Web Audio, so neither the widget nor the operator app, which
// plays the same tone, ships a sound file.

const GAP_MS = 2000;

let audio: AudioContext | undefined;
let lastPlayed = 0;

/**
 * Browsers start audio only after a click or a key press, so the context starts on the visitor's
 * first one inside the widget: the launcher's click or typing in the chat.
 */
export function prepareSound(root: ShadowRoot): void {
  const start = () => {
    try {
      audio ??= new AudioContext();
      audio.resume().catch(() => {});
    } catch {
      // No Web Audio here: the chat stays silent.
    }
  };
  root.addEventListener("pointerdown", start, true);
  root.addEventListener("keydown", start, true);
}

/** The chime for a new reply, at most once every 2 seconds. */
export function chime(): void {
  if (audio?.state !== "running" || Date.now() - lastPlayed < GAP_MS) return;
  lastPlayed = Date.now();
  playChime(audio);
}

/** Two notes, a fifth apart, that fade out. */
export function playChime(audio: AudioContext): void {
  const start = audio.currentTime;
  for (const [frequency, at] of [
    [784, 0],
    [1175, 0.13],
  ] as const) {
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0, start + at);
    volume.gain.linearRampToValueAtTime(0.08, start + at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.45);
    tone.connect(volume).connect(audio.destination);
    tone.start(start + at);
    tone.stop(start + at + 0.5);
  }
}
