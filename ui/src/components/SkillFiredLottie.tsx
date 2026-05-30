/**
 * SkillFiredLottie — the small lightning thumbnail that plays once when a
 * new skill-fired row arrives in the Timeline. After it plays, the row
 * holds a static lightning glyph at the same spot.
 *
 * Shares the lottie-react chunk + lightning.json fetch with
 * PremiumUnlockBurst: the dynamic import is cached at module level there,
 * so the first appearance of EITHER component triggers the load and every
 * subsequent appearance is instant. We reach into PremiumUnlockBurst's
 * loader rather than duplicating it.
 *
 * Sized 60×60 — distinctive enough to register, small enough not to
 * dominate a row. Replaces the row's normal dot indicator for skill-fired
 * rows, so it doesn't widen the layout.
 *
 * Plays at most once per row (keyed off the row id). For older rows that
 * existed before the user opened the Timeline, the lottie skips and we
 * render only the static glyph — replaying for hundreds of historical
 * rows would be obnoxious.
 */
import { useEffect, useState, type ComponentType } from "react";
import { Zap } from "lucide-react";
import { useMotion } from "../hooks/useMotion.ts";

interface SkillFiredLottieProps {
  /** True if this row was added live (not a historical replay). Only live
   *  rows animate; historical rows render the static glyph immediately. */
  animate: boolean;
}

interface LoadedAssets {
  LottieComponent: ComponentType<{
    animationData: unknown;
    loop?: boolean;
    autoplay?: boolean;
    onComplete?: () => void;
    "aria-hidden"?: string;
  }>;
  animationData: unknown;
}

// Module-level cache shared across all SkillFiredLottie instances. The
// PremiumUnlockBurst component has its own (it loads the same files), and
// the browser/bundler dedupes the underlying chunk + the JSON fetch.
let cached: LoadedAssets | null = null;
let inflight: Promise<LoadedAssets> | null = null;

async function loadAssets(): Promise<LoadedAssets> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const [lottieMod, jsonRes] = await Promise.all([
      import("lottie-react"),
      fetch("/animations/lightning.json").then((r) => {
        if (!r.ok) throw new Error(`lightning.json fetch: ${r.status}`);
        return r.json();
      }),
    ]);
    cached = {
      LottieComponent: lottieMod.default as LoadedAssets["LottieComponent"],
      animationData: jsonRes,
    };
    inflight = null;
    return cached;
  })().catch((e) => {
    inflight = null;
    throw e;
  });
  return inflight;
}

/** Static glyph rendered before lottie loads, after it finishes, and when
 *  motion is off. Kept in-component (not a separate file) so the import
 *  surface stays a single name. */
function StaticBolt() {
  return (
    <Zap
      className="size-3 fill-yellow-400 text-yellow-500"
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

export function SkillFiredLottie({ animate }: SkillFiredLottieProps) {
  const motionOn = useMotion();
  const [assets, setAssets] = useState<LoadedAssets | null>(cached);
  const [phase, setPhase] = useState<"loading" | "playing" | "done">(
    cached && animate && motionOn ? "playing" : "done",
  );

  useEffect(() => {
    if (!animate || !motionOn) {
      setPhase("done");
      return;
    }
    if (assets) {
      setPhase("playing");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    loadAssets()
      .then((a) => {
        if (cancelled) return;
        setAssets(a);
        setPhase("playing");
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("done");
      });
    return () => {
      cancelled = true;
    };
  }, [animate, motionOn, assets]);

  // Container sits where the row's dot indicator used to render — 12px wide
  // matches `w-3` upstream. The 60×60 lottie blooms outward absolutely so it
  // doesn't actually push siblings; the static glyph fills the inline slot
  // once we're done.
  return (
    <span className="relative flex w-3 items-center justify-center">
      {phase === "playing" && assets && (
        <span
          className="pointer-events-none absolute"
          style={{ width: 60, height: 60, left: -24, top: -24 }}
        >
          <assets.LottieComponent
            animationData={assets.animationData}
            loop={false}
            autoplay
            onComplete={() => setPhase("done")}
            aria-hidden="true"
          />
        </span>
      )}
      <StaticBolt />
    </span>
  );
}
