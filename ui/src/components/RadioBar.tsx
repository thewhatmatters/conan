import { useEffect, useRef, useState } from "react";
import { Pause, Play, Radio } from "lucide-react";

// Claude Radio — the YouTube live stream this bar streams.
// https://www.youtube.com/live/YmQ7jRgf4f0
const VIDEO_ID = "YmQ7jRgf4f0";
const YT_API_SRC = "https://www.youtube.com/iframe_api";

// Minimal shape of the bits of the YouTube IFrame Player API we touch.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
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
 * The actual
 * player is an offscreen (1×1, visually hidden) YouTube IFrame Player driven via
 * the IFrame Player API — only its play/pause + state surface is exposed here.
 *
 * The bar starts PAUSED: audio plays only after the user clicks Play, so the
 * click gesture satisfies the browser autoplay-with-sound policy. The button
 * reflects the player's *real* state via onStateChange (not optimistic). If the
 * stream has ended or errors (unavailable / not embeddable), the control is
 * disabled with a muted "offline" label rather than a dead button.
 */
export default function RadioBar() {
  // The node YT.Player replaces with its <iframe>; kept inside an offscreen box.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !mountRef.current || !window.YT) return;
      playerRef.current = new window.YT.Player(mountRef.current, {
        videoId: VIDEO_ID,
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
            if (!cancelled) setReady(true);
          },
          onStateChange: (e) => {
            if (cancelled || !window.YT) return;
            const st = window.YT.PlayerState;
            if (e.data === st.PLAYING || e.data === st.BUFFERING) {
              setPlaying(true);
            } else if (e.data === st.PAUSED) {
              setPlaying(false);
            } else if (e.data === st.ENDED) {
              setPlaying(false);
              setOffline(true); // stream ended -> treat as offline
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
  }, []);

  const disabled = !ready || offline;

  const toggle = () => {
    const p = playerRef.current;
    if (!p || disabled) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  };

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={playing ? "Pause Claude Radio" : "Play Claude Radio"}
        title={
          offline
            ? "Claude Radio is offline"
            : playing
              ? "Pause Claude Radio"
              : "Play Claude Radio"
        }
        className="inline-flex items-center justify-center rounded text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
      >
        {playing ? (
          <Pause className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
      </button>
      <Radio className="size-3.5 shrink-0" />
      <span className={offline ? "text-muted-foreground" : "text-foreground"}>
        Claude Radio{offline && " — offline"}
      </span>
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
