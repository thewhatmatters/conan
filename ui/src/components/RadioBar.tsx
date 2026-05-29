import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Radio, SquarePause, SquarePlay } from "lucide-react";
import type { RadioState } from "../hooks/useRadio.ts";

const YT_API_SRC = "https://www.youtube.com/iframe_api";
/** Fallback when the gateway hasn't reported its current state yet (first
 *  paint, or the radio API is unavailable). Mirrors src/radio/index.ts's
 *  `DEFAULT_RADIO_VIDEO_ID`. */
const FALLBACK_VIDEO_ID = "YmQ7jRgf4f0";
const FALLBACK_TITLE = "Claude Radio";

// Minimal shape of the bits of the YouTube IFrame Player API we touch.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(videoId: string): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  destroy(): void;
}
interface YTPlayerEvent {
  data: number;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId: string;
          width?: number;
          height?: number;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: () => void;
            onStateChange?: (e: YTPlayerEvent) => void;
            onError?: (e: YTPlayerEvent) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Load the IFrame API script once (lazily); resolve when window.YT.Player exists.
// Chains any existing onYouTubeIframeAPIReady so we don't clobber a prior loader.
let apiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = YT_API_SRC;
    document.head.appendChild(tag);
  });
  return apiPromise;
}

/**
 * Claude Radio (US-011): a toolbar pinned at the bottom of the HUD panel with a
 * single play/pause control that streams a YouTube live stream as ambient audio.
 * The player is an offscreen (1×1, visually hidden) YouTube IFrame Player; the
 * `radio` prop comes from `useRadio` (initial GET + WS broadcasts) so the
 * bundled `/conan-change-radio` skill can swap the stream + title at runtime
 * without remounting this component or interrupting playback for stale state.
 *
 * The bar starts PAUSED: audio plays only after the user clicks Play, so the
 * click gesture satisfies the browser autoplay-with-sound policy. The button
 * reflects the player's *real* state via onStateChange (not optimistic). If the
 * stream has ended or errors (unavailable / not embeddable), the control is
 * disabled with a muted "offline" label rather than a dead button — until the
 * radio state is changed again, at which point we re-enable + retry.
 */
export default function RadioBar({ radio }: { radio: RadioState | null }) {
  // The node YT.Player replaces with its <iframe>; kept inside an offscreen box.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [offline, setOffline] = useState(false);
  // Track the videoId the *player* is actually pointed at so a re-render with
  // the same id doesn't trigger a needless loadVideoById (which would reset
  // playback to the start). Initialised to "" so the first known id always
  // applies.
  const loadedIdRef = useRef<string>("");

  const videoId = radio?.videoId ?? FALLBACK_VIDEO_ID;
  const title = radio?.title ?? FALLBACK_TITLE;

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !mountRef.current || !window.YT) return;
      playerRef.current = new window.YT.Player(mountRef.current, {
        videoId,
        width: 1,
        height: 1,
        // No autoplay (start paused), no native chrome — we drive it.
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            setReady(true);
            loadedIdRef.current = videoId;
          },
          onStateChange: (e) => {
            if (cancelled || !window.YT) return;
            const st = window.YT.PlayerState;
            if (e.data === st.PLAYING || e.data === st.BUFFERING) {
              setPlaying(true);
            } else if (e.data === st.PAUSED) {
              setPlaying(false);
            } else if (e.data === st.ENDED) {
              // Auto-loop: finite videos reach END at their natural runtime;
              // restart from frame 0 so the radio keeps playing. A truly-dead
              // live stream will return ENDED briefly then hit onError on
              // retry, which marks the bar offline cleanly. The 50ms gap
              // dodges a race where playVideo() called inline from
              // onStateChange is swallowed by the player's own state machine.
              setTimeout(() => {
                if (cancelled) return;
                const p = playerRef.current;
                if (!p) return;
                try {
                  p.seekTo(0);
                  p.playVideo();
                } catch {
                  /* player disposed mid-loop — ignore */
                }
              }, 50);
            }
          },
          // Invalid/unavailable/not-embeddable video -> disable the control.
          onError: () => {
            if (cancelled) return;
            setPlaying(false);
            setOffline(true);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        /* player may not have finished initializing */
      }
      playerRef.current = null;
    };
    // Player is created exactly once — videoId changes are handled by the
    // loadVideoById effect below to avoid tearing down the iframe + reloading
    // the YouTube API for every swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live stream-swap: when the gateway reports a new videoId, point the
  // existing player at it via loadVideoById. Resets the offline flag so a
  // previously-ended stream gets a fresh shot; preserves play/pause state
  // across the swap (YouTube continues playback on the new id if we were
  // playing, otherwise it stays CUED until the user hits Play).
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !ready) return;
    if (loadedIdRef.current === videoId) return;
    try {
      p.loadVideoById(videoId);
      loadedIdRef.current = videoId;
      setOffline(false);
    } catch {
      /* player might have been disposed in the same tick — retry on next change */
    }
  }, [videoId, ready]);

  const disabled = !ready || offline;

  const toggle = () => {
    const p = playerRef.current;
    if (!p || disabled) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  };

  // Title shown in the toolbar — the gateway's resolved YouTube title when
  // present, otherwise the default "Claude Radio" label. Truncated to keep
  // long titles from blowing the toolbar past 1 row.
  const displayTitle = offline ? `${title} — offline` : title;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={playing ? `Pause ${title}` : `Play ${title}`}
        title={
          offline
            ? `${title} is offline`
            : playing
              ? `Pause ${title}`
              : `Play ${title}`
        }
        className="inline-flex items-center justify-center rounded text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
      >
        {playing ? (
          <SquarePause className="size-3.5" />
        ) : (
          <SquarePlay className="size-3.5" />
        )}
      </button>
      {playing ? <Equalizer /> : <Radio className="size-3.5 shrink-0" />}
      <MarqueeTitle
        text={displayTitle}
        className={offline ? "text-muted-foreground" : "text-foreground"}
      />
      {/* Offscreen 1×1 player: YT.Player replaces the inner div with its iframe.
          Visually hidden but not display:none (display:none can stop audio). */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 size-px overflow-hidden opacity-0"
      >
        <div ref={mountRef} />
      </div>
    </footer>
  );
}

/**
 * Five-bar equalizer — the playing-state stand-in for the static Radio icon.
 * Bars are `items-end` so they grow upward and animate `height` + background
 * color on the same `eq-wave` keyframe so color tracks amplitude (green →
 * amber → red).
 *
 * Each bar gets its OWN duration + delay so the cycles drift in and out of
 * phase instead of marching in a uniform left-to-right wave — the bars look
 * like they're responding to a real audio signal. The durations are
 * deliberately non-round (0.83 / 1.27 / 1.09 / 1.51 / 0.77 s) so they
 * don't periodically resync; the delays are unrelated to bar order so no
 * single "leader" reads. Pure CSS, GPU-cheap, no JS frame loop.
 */
const EQ_BARS: { duration: number; delay: number }[] = [
  { duration: 0.83, delay: 0 },
  { duration: 1.27, delay: 230 },
  { duration: 1.09, delay: 560 },
  { duration: 1.51, delay: 100 },
  { duration: 0.77, delay: 410 },
];

/**
 * Title that auto-marquees when it's wider than the space it has. We measure
 * `scrollWidth - clientWidth` after each title/layout change; if positive, we
 * set a CSS variable with the negative overflow as pixels and apply the
 * `radio-marquee` keyframe (defined in `index.css`) which bounces the text
 * from 0 → -overflow → 0 forever, pausing at each end for readability.
 *
 * While marqueeing we apply an edge mask (linear-gradient transparent → black)
 * so the text fades in from the left and out to the right rather than
 * abruptly clipping at the container edges. When the title fits, the mask is
 * suppressed and the element behaves like a normal truncated `text-foreground`
 * span.
 */
function MarqueeTitle({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0); // negative px when overflowing, else 0

  // Re-measure on text change AND on container resize (HUD drag, theme switch,
  // font swap). useLayoutEffect runs before paint so the marquee doesn't
  // flash a stale geometry on first render.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const measure = () => {
      // The animation transforms `inner`, so wipe any in-flight transform
      // before reading scrollWidth — otherwise we'd measure a translated box.
      inner.style.transform = "";
      const overflow = inner.scrollWidth - wrap.clientWidth;
      setShift(overflow > 0 ? -overflow : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [text]);

  const marqueeing = shift < 0;

  return (
    <span
      ref={wrapRef}
      className={
        "relative min-w-0 flex-1 overflow-hidden whitespace-nowrap " + className
      }
      title={text}
    >
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap"
        style={
          marqueeing
            ? ({
                animation: "radio-marquee 12s ease-in-out infinite",
                ["--marquee-shift" as string]: `${shift}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
      {/* Two overlay gradients — each fades on the side where content is
          actively being clipped. Their opacity keyframes share the marquee's
          timing so they ramp in/out in lockstep with the text motion: left
          fade off at start position, on at end; right fade the inverse.
          `from-card` matches the toolbar bg so the fade reads as text
          dissolving rather than a colored overlay. */}
      {marqueeing && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-card to-transparent"
            style={{ animation: "radio-mask-left 12s ease-in-out infinite" }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-card to-transparent"
            style={{ animation: "radio-mask-right 12s ease-in-out infinite" }}
          />
        </>
      )}
    </span>
  );
}

function Equalizer() {
  return (
    <span
      aria-hidden
      className="inline-flex h-3.5 shrink-0 items-end gap-[2px]"
      title="Playing"
    >
      {EQ_BARS.map((bar, i) => (
        <span
          key={i}
          // No bg class on purpose: the initial color comes from the 0%
          // keyframe and the keyframe owns both height + color across the cycle.
          className="w-[2px] rounded-sm"
          style={{
            animation: `eq-wave ${bar.duration}s ease-in-out infinite`,
            animationDelay: `${bar.delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
