/**
 * Chiptune synth — the audio side of US-102's Free-tier easter egg.
 *
 * Why this exists: we wanted to actually swap Claude Radio to "Never Gonna
 * Give You Up" after the 5s/60s grace period, but every Rick Astley upload
 * on YouTube's IFrame API returns error 150 ("embedding disabled by the
 * video owner") in our 1×1 offscreen player. Rather than chase third-party
 * reuploads of dubious longevity, we synthesize the iconic chorus melody
 * inline with Web Audio API square-wave oscillators — recognizable, ad-free,
 * never fails to play, no copyright on the synthesized rendition.
 *
 * Public API:
 *   - `startRickroll()` — boot the AudioContext (if needed) and schedule
 *     the melody to loop forever. Idempotent: a second call while running
 *     is a no-op.
 *   - `stopRickroll()` — cancel scheduled notes, ramp the gain to zero, and
 *     close the context. Idempotent: safe to call when not playing.
 *
 * Tuned for the offscreen 1×1 player slot the YouTube iframe used to fill,
 * so it sounds like an additional channel rather than a UI alarm. Volume
 * sits at ~0.08 master gain — present in mixed audio, never blown out.
 */

/* ───── The melody — first two bars of "Never Gonna Give You Up" ────────
 *
 * Key: Bb major, tempo ~113 BPM (original recording's rough). The opening
 * vocal "Never gonna give you up / Never gonna let you down / Never gonna
 * run around and desert you" — first eight bars worth, then we loop.
 *
 * Frequencies are equal-tempered A4=440. Note values are 16th-note ticks
 * (TICK = 60/113/4 ≈ 0.133s) so durations stay relative to tempo. `f: 0`
 * is a rest.  */
const TEMPO_BPM = 113;
const TICK = 60 / TEMPO_BPM / 4; // 16th note in seconds

const PITCH = {
  G4: 392.0,
  A4: 440.0,
  Bb4: 466.16,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  F5: 698.46,
  G5: 783.99,
} as const;

interface Note {
  /** Frequency in Hz, or 0 for a rest. */
  f: number;
  /** Duration in 16th-note ticks. */
  t: number;
}

const MELODY: Note[] = [
  // "Never gon-na give you up" — pickup + downbeat
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.A4, t: 2 },
  { f: PITCH.G4, t: 2 },
  { f: PITCH.Bb4, t: 2 },
  { f: PITCH.C5, t: 4 },
  { f: 0, t: 1 },
  // "Never gon-na let you down"
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.A4, t: 2 },
  { f: PITCH.G4, t: 2 },
  { f: PITCH.D5, t: 4 },
  { f: PITCH.C5, t: 2 },
  { f: 0, t: 1 },
  // "Never gon-na run a-round and de-sert you"
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.A4, t: 1 },
  { f: PITCH.Bb4, t: 1 },
  { f: PITCH.A4, t: 1 },
  { f: PITCH.G4, t: 1 },
  { f: PITCH.F5, t: 2 },
  { f: PITCH.F5, t: 1 },
  { f: PITCH.Eb5, t: 1 },
  { f: PITCH.D5, t: 4 },
  { f: 0, t: 4 },
];

/** Total melody duration in seconds — used to schedule the next loop. */
const MELODY_DURATION_S = MELODY.reduce((s, n) => s + n.t * TICK, 0);

/* ───── Module state ──────────────────────────────────────────────────── */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let loopTimer: number | null = null;

/** Lazy-construct the AudioContext on first play. Browsers won't let us
 *  create an AudioContext until there's a user gesture, but the rickroll
 *  is gated by an earlier Play click + 5s timer — so the call chain runs
 *  inside the activation window. */
function ensureContext(): { ctx: AudioContext; master: GainNode } {
  if (ctx && masterGain) return { ctx, master: masterGain };
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.08; // present, never blown out
  masterGain.connect(ctx.destination);
  return { ctx, master: masterGain };
}

/** Play one note (or rest) at an exact AudioContext time. Each note gets
 *  its own oscillator + ADSR envelope so consecutive notes don't pop. */
function playNote(
  ac: AudioContext,
  master: GainNode,
  freq: number,
  startTime: number,
  duration: number,
): void {
  if (freq === 0) return; // rest
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = "square"; // 8-bit chiptune feel
  osc.frequency.value = freq;
  osc.connect(env);
  env.connect(master);
  // Tight ADSR — fast attack so notes don't slur, short release so the
  // square wave doesn't click at the tail.
  env.gain.setValueAtTime(0, startTime);
  env.gain.linearRampToValueAtTime(1, startTime + 0.005);
  env.gain.linearRampToValueAtTime(0.7, startTime + 0.04);
  env.gain.linearRampToValueAtTime(0, startTime + duration - 0.01);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** Schedule one full pass of the melody starting at `cursor`, then queue
 *  the next pass via a setTimeout right at the end. */
function scheduleMelody(): void {
  if (!ctx || !masterGain) return;
  const start = ctx.currentTime + 0.05;
  let cursor = start;
  for (const note of MELODY) {
    const duration = note.t * TICK;
    playNote(ctx, masterGain, note.f, cursor, duration);
    cursor += duration;
  }
  // Schedule next loop slightly before the previous one ends so there's
  // no audible gap. The 50ms lead lets the new pass's first note's
  // attack start before the last rest finishes.
  loopTimer = window.setTimeout(
    scheduleMelody,
    Math.max(0, (MELODY_DURATION_S - 0.05) * 1000),
  );
}

/* ───── Public API ────────────────────────────────────────────────────── */

/** Start the rickroll loop. Idempotent. */
export function startRickroll(): void {
  if (loopTimer !== null) return; // already running
  ensureContext();
  scheduleMelody();
}

/** Stop the rickroll loop and tear down the AudioContext so the browser
 *  releases the audio device. Idempotent. */
export function stopRickroll(): void {
  if (loopTimer !== null) {
    window.clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (masterGain && ctx) {
    // Quick fade-out to avoid a click at the cutoff.
    try {
      masterGain.gain.cancelScheduledValues(ctx.currentTime);
      masterGain.gain.setValueAtTime(masterGain.gain.value, ctx.currentTime);
      masterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
    } catch {
      // ctx already closed; nothing to do.
    }
  }
  if (ctx) {
    const closing = ctx;
    ctx = null;
    masterGain = null;
    // Defer the close so the fade-out actually renders.
    window.setTimeout(() => {
      closing.close().catch(() => {});
    }, 100);
  }
}
