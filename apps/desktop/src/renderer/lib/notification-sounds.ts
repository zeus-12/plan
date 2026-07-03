import type { SoundId } from "./notification-settings";

/**
 * Notification chimes, synthesized with the Web Audio API. No asset files: each
 * preset is a few oscillators with a short percussive envelope, so playback is
 * instant, reliable cross-platform, and trivially tunable. `playSound` is also
 * the preview used by the settings picker.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    // A click anywhere resumes a suspended context; resume defensively so a
    // notification that fires later still produces sound.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * One enveloped note. `start` is an offset (seconds) from now so presets can
 * arpeggiate. The gain ramps up fast then decays exponentially — a soft,
 * bell-like shape rather than a hard square edge.
 */
function note(
  ac: AudioContext,
  opts: {
    freq: number;
    type?: OscillatorType;
    start?: number;
    dur?: number;
    gain?: number;
  },
) {
  const { freq, type = "sine", start = 0, dur = 0.18, gain = 0.18 } = opts;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const PRESETS: Record<Exclude<SoundId, "off">, (ac: AudioContext) => void> = {
  // A single soft blip.
  ping: (ac) => note(ac, { freq: 880, dur: 0.14, gain: 0.16 }),
  // Two-note rising chime.
  chime: (ac) => {
    note(ac, { freq: 659.25, dur: 0.22, gain: 0.14 });
    note(ac, { freq: 987.77, start: 0.1, dur: 0.28, gain: 0.14 });
  },
  // Percussive, fast-decaying wood tone with an octave shimmer.
  marimba: (ac) => {
    note(ac, { freq: 523.25, type: "triangle", dur: 0.26, gain: 0.18 });
    note(ac, { freq: 1046.5, type: "sine", dur: 0.16, gain: 0.06 });
  },
  // Bright, glassy two-tone.
  glass: (ac) => {
    note(ac, { freq: 1318.5, type: "triangle", dur: 0.16, gain: 0.1 });
    note(ac, {
      freq: 1975.5,
      type: "triangle",
      start: 0.05,
      dur: 0.2,
      gain: 0.08,
    });
  },
};

/** Play the given preset. "off" (or an unknown id) is a silent no-op. */
export function playSound(id: SoundId) {
  if (id === "off") return;
  const preset = PRESETS[id];
  if (!preset) return;
  const ac = audio();
  if (!ac) return;
  try {
    preset(ac);
  } catch {
    // Audio can fail (no output device, autoplay policy) — never throw from a
    // notification path.
  }
}
