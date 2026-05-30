import { DEFAULT_RADIO_VIDEO_ID, parseYouTubeId } from "./index.js";

/**
 * Claude Radio embed-host page (v4.6 WKWebView fix).
 *
 * WHY THIS EXISTS — the bundled Tauri app's webview origin is the custom scheme
 * `tauri://localhost`. YouTube's IFrame embed refuses to play for any non-http(s)
 * origin: it fires `onError` 153 ("invalid origin") and never starts audio. So
 * the radio worked in a plain browser and in `tauri dev` (both `http://…:5173`
 * origins) but was dead in the packaged app — the exact "still can't play" bug.
 *
 * The fix: run the YouTube player inside a document served over a *real http
 * origin* — the loopback gateway (`http://127.0.0.1:3747`). `RadioBar.tsx` loads
 * THIS page in an `<iframe>` and drives play/pause/swap over `postMessage`. The
 * player now sees an http origin YouTube accepts, so audio plays everywhere.
 *
 * The page is self-contained (only external load is YouTube's IFrame API) and
 * carries the same forgiving error-recovery + auto-loop the old in-app player
 * had. It is intentionally tiny and exposes nothing sensitive (it just plays a
 * public YouTube id), so the route serving it is unauthenticated.
 *
 * postMessage protocol (both directions tagged so unrelated frames are ignored):
 *  - parent → iframe: `{ source:'conan-radio', action:'play'|'pause'|'load', videoId? }`
 *  - iframe → parent: `{ source:'conan-radio-embed', ready, playing, offline }`
 */

// Recovery cadence — mirrors the values the old RadioBar used: a couple of fast
// re-cues to ride out a transient load-race blip, then a slow heal loop so a
// longer outage still self-recovers without the user touching anything.
const MAX_QUICK_RETRIES = 2;
const QUICK_RETRY_MS = 1500;
const HEAL_RETRY_MS = 30_000;

/**
 * Render the embed-host HTML for a given (already-validated) video id. The id is
 * the only interpolated value and it is constrained to `[A-Za-z0-9_-]{11}` by
 * {@link sanitizeEmbedVideoId}, so there is no injection surface in the literal.
 */
export function radioEmbedHtml(videoId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Radio</title>
<style>
  /* The host page is never seen — it lives inside an offscreen 1x1 iframe.
     Keep it blank + non-interactive; the YT iframe is injected into #player. */
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  #player { width: 1px; height: 1px; }
</style>
</head>
<body>
<div id="player"></div>
<script>
(function () {
  "use strict";
  var INITIAL_ID = ${JSON.stringify(videoId)};
  var MAX_QUICK_RETRIES = ${MAX_QUICK_RETRIES};
  var QUICK_RETRY_MS = ${QUICK_RETRY_MS};
  var HEAL_RETRY_MS = ${HEAL_RETRY_MS};

  var player = null;
  var ready = false;
  var playing = false;
  var offline = false;
  var currentId = INITIAL_ID;
  var retries = 0;
  var recoverTimer = null;
  // Commands that arrive before the player is ready are buffered and applied on
  // onReady (onReady is fast, but a Play click can race the API load).
  var pending = null;

  function postState() {
    try {
      window.parent.postMessage(
        { source: "conan-radio-embed", ready: ready, playing: playing, offline: offline },
        "*"
      );
    } catch (e) { /* parent gone */ }
  }

  function scheduleRecue(delay) {
    if (recoverTimer != null) return;
    recoverTimer = window.setTimeout(function () {
      recoverTimer = null;
      if (!player) return;
      try { player.cueVideoById(currentId); } catch (e) { /* disposed */ }
    }, delay);
  }

  function clearRecover() {
    if (recoverTimer != null) { clearTimeout(recoverTimer); recoverTimer = null; }
  }

  // ---- parent → iframe command channel -------------------------------------
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== "conan-radio") return;
    if (d.action === "play") {
      if (!player || !ready) { pending = "play"; return; }
      try { player.playVideo(); } catch (e2) {}
    } else if (d.action === "pause") {
      if (!player || !ready) { pending = "pause"; return; }
      try { player.pauseVideo(); } catch (e2) {}
    } else if (d.action === "load" && typeof d.videoId === "string") {
      if (d.videoId === currentId) return;
      currentId = d.videoId;
      offline = false; retries = 0; clearRecover();
      if (player && ready) {
        // loadVideoById preserves play/pause intent (continues if playing,
        // else stays cued); matches the old in-app swap behaviour.
        try { player.loadVideoById(currentId); } catch (e3) {}
      }
      postState();
    }
  });

  function onReady() {
    ready = true;
    postState();
    if (pending === "play") { try { player.playVideo(); } catch (e) {} }
    else if (pending === "pause") { try { player.pauseVideo(); } catch (e) {} }
    pending = null;
  }

  function onStateChange(e) {
    var st = window.YT.PlayerState;
    if (e.data === st.PLAYING || e.data === st.BUFFERING) {
      playing = true; offline = false; retries = 0; postState();
    } else if (e.data === st.CUED) {
      offline = false; retries = 0; postState();
    } else if (e.data === st.PAUSED) {
      playing = false; postState();
    } else if (e.data === st.ENDED) {
      // Auto-loop finite videos so the radio keeps going. A truly-dead live
      // stream returns ENDED then errors on retry, which marks offline cleanly.
      setTimeout(function () {
        if (!player) return;
        try { player.seekTo(0); player.playVideo(); } catch (e2) {}
      }, 50);
    }
  }

  function onError(e) {
    // YT error codes: 2 (invalid param) | 5 (HTML5) | 100 (gone) |
    // 101 / 150 (owner-disabled embedding). Log so the user can read the
    // actual code in DevTools if a station refuses to play — the Lo-fi live
    // stream tends to embed clean, but music-video uploads (eg. the Rick Roll
    // easter egg) have hit 101/150 in past tests. The log is harmless when
    // everything works.
    try { console.warn("[conan-radio-embed] YT error code", e && e.data, "for", currentId); } catch (_) {}
    playing = false;
    if (retries < MAX_QUICK_RETRIES) {
      retries += 1;
      scheduleRecue(QUICK_RETRY_MS);
    } else {
      offline = true;
      scheduleRecue(HEAL_RETRY_MS);
    }
    postState();
  }

  window.onYouTubeIframeAPIReady = function () {
    // host: youtube-nocookie.com — the privacy-enhanced embed domain. Lifts a
    // number of cross-origin embed restrictions that the canonical youtube.com
    // host enforces (some music-video uploads only embed cleanly here). Live
    // streams + ordinary videos play identically through it, so this is a safe
    // upgrade for the whole radio surface, not just the easter-egg path.
    // origin: window.location.origin — required by YouTube for any embed that
    // wants to drive postMessage commands back into a non-default origin. The
    // embed page is hosted by our gateway at http://127.0.0.1:3747, so we pass
    // that origin so YouTube accepts our load/play/pause commands.
    player = new window.YT.Player("player", {
      videoId: INITIAL_ID,
      width: 1,
      height: 1,
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: { onReady: onReady, onStateChange: onStateChange, onError: onError }
    });
  };

  var tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);

  // Announce a not-yet-ready state immediately so the parent can show a sane
  // (disabled) control until onReady arrives.
  postState();
})();
</script>
</body>
</html>`;
}

/**
 * Validate + normalise the `?v=` query for the embed route. Reuses the same
 * YouTube id/URL parser the POST route uses, and falls back to the default
 * station when the input is missing or unparseable — the embed page should
 * always render a playable id rather than 400.
 */
export function sanitizeEmbedVideoId(input: unknown): string {
  if (typeof input === "string") {
    const id = parseYouTubeId(input);
    if (id) return id;
  }
  return DEFAULT_RADIO_VIDEO_ID;
}
