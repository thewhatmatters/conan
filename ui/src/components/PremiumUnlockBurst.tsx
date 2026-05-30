/**
 * PremiumUnlockBurst — fires when Free → Premium kicks in. Plays the
 * lightning Lottie from `/animations/lightning.json` once, then unmounts.
 *
 * Both the player runtime (`lottie-react`, ~500KB raw / ~106KB gzipped)
 * AND the animation JSON (~220KB) are dynamic-imported the first time the
 * burst plays — neither lives in the critical-path bundle. A successful
 * Premium upgrade is a once-per-customer event; loading the dependency
 * eagerly would penalize every cold start to save ~half a second on a
 * single moment in the app's lifetime.
 *
 * Module-level cache keeps subsequent plays instant (re-applying or
 * swapping a license while testing).
 *
 * Trigger model: the parent flips `play` true → the animation runs once,
 * then `onDone` fires so the parent can reset its flag. Re-flipping `play`
 * lets it play again. Pointer-events stay off so it never blocks the
 * dialog underneath; aria-hidden so screen readers ignore (the textual
 * "Premium features unlocked." line is the actual announcement).
 *
 * Reduced motion: skipped entirely. Users who opted out get the textual
 * success state and nothing else.
 */
import { useEffect, useState, type ComponentType } from "react";

interface PremiumUnlockBurstProps {
  /** Toggle to fire the animation. Flip true → the burst plays once,
   *  then onDone fires. */
  play: boolean;
  /** Fires when the animation finishes so the parent can reset its flag. */
  onDone?: () => void;
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

/** Module-level cache so neither the runtime nor the 220KB JSON gets fetched
 *  twice in a session, even if the user toggles Premium on/off to test. */
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

export function PremiumUnlockBurst({ play, onDone }: PremiumUnlockBurstProps) {
  const [assets, setAssets] = useState<LoadedAssets | null>(cached);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!play) return;
    if (prefersReducedMotion()) {
      onDone?.();
      return;
    }
    if (assets) {
      setActive(true);
      return;
    }
    let cancelled = false;
    loadAssets()
      .then((a) => {
        if (cancelled) return;
        setAssets(a);
        setActive(true);
      })
      .catch((e) => {
        console.warn("[PremiumUnlockBurst] load failed:", e);
        onDone?.();
      });
    return () => {
      cancelled = true;
    };
  }, [play, assets, onDone]);

  if (!active || !assets) return null;

  const { LottieComponent, animationData } = assets;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
    >
      <div style={{ width: 240, height: 240 }}>
        <LottieComponent
          animationData={animationData}
          loop={false}
          autoplay
          onComplete={() => {
            setActive(false);
            onDone?.();
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
