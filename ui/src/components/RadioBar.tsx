import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Radio, SquarePause, SquarePlay } from "lucide-react";
import type { RadioState } from "../hooks/useRadio.ts";
import { radioEmbedUrl } from "../lib/gateway.ts";
import { useTier } from "../hooks/useTier.ts";
import { startRickroll, stopRickroll } from "../lib/chiptune.ts";

/** Fallback when the gateway hasn't reported its current state yet (first
 *  paint, or the radio API is unavailable). Mirrors src/radio/index.ts's
 *  `DEFAULT_RADIO_VIDEO_ID`. */
const FALLBACK_VIDEO_ID = "YmQ7jRgf4f0";
const FALLBACK_TITLE = "Claude Radio";

/** US-102 easter egg: after N seconds of cumulative play on the Free tier,
 *  Claude Radio is hijacked — the embedded YouTube player pauses, a
 *  Web Audio API chiptune of "Never Gonna Give You Up" kicks on, and the
 *  marquee swaps to a Rick taunt. The override stays sticky for the
 *  session — pause/play can't dodge it — and releases the moment
 *  `useTier()` flips to premium (chiptune stops, YT resumes). Premium
 *  users never see this codepath, which is the whole point.
 *
 *  Why a chiptune instead of swapping the YT videoId: every Rick Astley
 *  upload returns YT IFrame error 150 (owner-disabled embedding) in our
 *  1×1 offscreen player. The chiptune in lib/chiptune.ts synthesizes the
 *  iconic chorus melody with square-wave oscillators — recognizable,
 *  ad-free, never fails to play. */
const RICK_TITLE = "Never Gonna Give You Up · Premium for real channels";
/** Cumulative-play grace before the rickroll kicks in. 5s for testing,
 *  bump to 60_000 (60s) before shipping. */
const FREE_RADIO_GRACE_MS = 5_000;

/** Origin of the embed-host page — the target for command postMessages, and the
 *  origin we accept state messages from. Derived from the embed URL so it stays
 *  in lockstep with `radioEmbedUrl` (the loopback gateway, http origin). */
const EMBED_ORIGIN = new URL(radioEmbedUrl("x")).origin;

/** State the embed-host page reports up over postMessage. */
interface EmbedState {
  source: "conan-radio-embed";
  ready: boolean;
  playing: boolean;
  offline: boolean;
}

/**
 * Claude Radio (US-011): a toolbar pinned at the bottom of the HUD panel with a
 * single play/pause control that streams a YouTube live stream as ambient audio.
 *
 * v4.6 WKWebView fix — the YouTube player does NOT run in this component's
 * document. The bundled app's webview origin is the custom scheme
 * `tauri://localhost`, and YouTube's IFrame embed refuses to play for any
 * non-http(s) origin (fires `onError` 153, never starts audio) — so the radio
 * worked in a browser / `tauri dev` (http origins) but was dead in the packaged
 * app. Instead we host the player in an offscreen `<iframe>` pointed at the
 * gateway's loopback **http** origin (`/radio/embed`), which YouTube accepts,
 * and drive it over `postMessage`:
 *  - parent → iframe: `{ source:'conan-radio', action:'play'|'pause'|'load', videoId? }`
 *  - iframe → parent: `{ source:'conan-radio-embed', ready, playing, offline }`
 *
 * The `radio` prop (from `useRadio`) supplies the current videoId + title; a
 * swap sends a `load` command so the bundled `/conan-change-radio` skill can
 * change the stream without reloading the iframe. The bar starts PAUSED — audio
 * begins only after the user clicks Play. The button reflects the embed's *real*
 * player state (not optimistic); forgiving error-recovery + auto-loop live in
 * the embed page (src/radio/embed.ts).
 */
export default function RadioBar({ radio }: { radio: RadioState | null }) {
  const tier = useTier();
  const isFree = tier.tier === "free";
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [offline, setOffline] = useState(false);
  // The videoId the embed player is actually pointed at, so a re-render with the
  // same id doesn't re-send a needless `load` (which would restart playback).
  const loadedIdRef = useRef<string>("");
  // US-102 easter egg: cumulative play-time counter (ms) toward the 60s grace.
  // playStartRef holds the timestamp the current play-burst began; on pause we
  // fold the burst's duration into elapsedRef and clear the start. Once
  // elapsedRef crosses FREE_RADIO_GRACE_MS, `rickRolled` flips and the videoId
  // override below points the embed at Rick. Cumulative (not "60s continuous")
  // so a pause/play loop can't cheese it.
  const [rickRolled, setRickRolled] = useState(false);
  const playStartRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);

  // Drive the cumulative timer. On a play→pause transition we settle the
  // current burst; on play we arm a setTimeout for the remainder. Releasing
  // the effect (pause, tier flip, rick fired) clears the pending timer and
  // folds elapsed time so the next play resumes the count.
  useEffect(() => {
    if (!isFree || rickRolled) return;
    if (!playing) return;
    playStartRef.current = Date.now();
    const remaining = Math.max(0, FREE_RADIO_GRACE_MS - elapsedRef.current);
    const t = window.setTimeout(() => {
      elapsedRef.current = FREE_RADIO_GRACE_MS;
      setRickRolled(true);
    }, remaining);
    return () => {
      window.clearTimeout(t);
      if (playStartRef.current !== null) {
        elapsedRef.current += Date.now() - playStartRef.current;
        playStartRef.current = null;
      }
    };
  }, [isFree, playing, rickRolled]);

  // Snap back to the real station if the user upgrades mid-roll. Also clears
  // the elapsed counter so a downgrade restarts the 60s clock from zero.
  useEffect(() => {
    if (!isFree) {
      elapsedRef.current = 0;
      if (rickRolled) setRickRolled(false);
    }
  }, [isFree, rickRolled]);

  // US-102 audio side: when rickRolled flips on, pause the YT player (so we
  // don't have dual audio) and start the chiptune; on the flip back
  // (upgrade), stop the chiptune and resume YT so audio continuity carries
  // the user across the transition.  The cumulative-play timer only counts
  // playing time, so whenever rickRolled flips true the user is currently
  // playing — the resume on cleanup is therefore the right intent.
  useEffect(() => {
    if (!rickRolled) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: "conan-radio", action: "pause" },
      EMBED_ORIGIN,
    );
    startRickroll();
    return () => {
      stopRickroll();
      iframeRef.current?.contentWindow?.postMessage(
        { source: "conan-radio", action: "play" },
        EMBED_ORIGIN,
      );
    };
  }, [rickRolled]);

  // videoId always rides the gateway value — we never ask YT to load Rick
  // (it would just 150 anyway). Only the title swaps, and the chiptune
  // effect below takes over the audio role when rickRolled flips.
  const videoId = radio?.videoId ?? FALLBACK_VIDEO_ID;
  const title = rickRolled ? RICK_TITLE : (radio?.title ?? FALLBACK_TITLE);

  // The iframe src is set ONCE (from the first known id) — subsequent swaps go
  // over the `load` postMessage so the iframe + YouTube API aren't torn down and
  // reloaded on every change. Lazy init captures the id at first render.
  const [embedSrc] = useState(() => radioEmbedUrl(videoId));

  // Listen for state the embed page reports up. Guarded on both the message
  // source tag AND that it came from our iframe's window, so unrelated frames
  // (or the YouTube iframe nested inside the embed) can't spoof state.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as EmbedState | undefined;
      if (!d || d.source !== "conan-radio-embed") return;
      setReady(d.ready);
      setPlaying(d.playing);
      setOffline(d.offline);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const sendCommand = (msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: "conan-radio", ...msg },
      EMBED_ORIGIN,
    );
  };

  // Live stream-swap: when the gateway reports a new videoId, tell the embed to
  // load it (preserving play/pause intent). Waits for `ready` so the command
  // isn't dropped before the player exists; the embed also buffers a too-early
  // command as a backstop.
  useEffect(() => {
    if (!ready) return;
    if (loadedIdRef.current === "") loadedIdRef.current = embedSrcVideoId(embedSrc);
    if (loadedIdRef.current === videoId) return;
    sendCommand({ action: "load", videoId });
    loadedIdRef.current = videoId;
    setOffline(false);
  }, [videoId, ready, embedSrc]);

  const disabled = !ready || offline;

  const toggle = () => {
    if (disabled) return;
    sendCommand({ action: playing ? "pause" : "play" });
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
      {/* Offscreen 1×1 iframe hosting the actual YouTube player at the gateway's
          http origin (v4.6 WKWebView fix). Visually hidden but not display:none
          (display:none can stop audio). */}
      <iframe
        ref={iframeRef}
        src={embedSrc}
        title="Claude Radio player"
        aria-hidden
        // `allow` grants the cross-origin frame the autoplay + media permissions
        // a YouTube embed needs once Play is pressed.
        allow="autoplay; encrypted-media"
        className="pointer-events-none fixed left-0 top-0 size-px overflow-hidden border-0 opacity-0"
      />
    </footer>
  );
}

/** Recover the videoId from an embed URL so the swap effect can compare against
 *  the id the iframe was first pointed at without threading extra state. */
function embedSrcVideoId(src: string): string {
  try {
    return new URL(src).searchParams.get("v") ?? "";
  } catch {
    return "";
  }
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
