/**
 * Claude Radio state — in-memory, session-only.
 *
 * The radio's current videoId + title lives here and only here. There's no
 * disk persistence by design: when the gateway restarts (app relaunch) the
 * default `Claude Radio` stream comes back. The UI subscribes to changes via
 * a `{type:'radio'}` WS broadcast and re-targets its YouTube player.
 *
 * Lookups use YouTube's public oEmbed endpoint (no API key required) — we
 * fetch only the title; the video itself is loaded by the UI player.
 */

/**
 * A curated radio station — a named YouTube video the user can pick by name or
 * vibe via the `/conan-change-radio` skill.
 */
export interface RadioStation {
  name: string;
  /** 11-char YouTube video ID. */
  id: string;
  /** Free-form vibe/genre keywords the skill matches against ("epic", "focus"). */
  tags: string[];
}

/**
 * The authoritative curated station list. Lives here — compiled into the
 * gateway sidecar binary — rather than in a skill-side `stations.json`, so the
 * set of named stations ships inside the signed Tauri app and can't be altered
 * by editing the (user-writable) skill files. The `/conan-change-radio` skill
 * sources this via `GET /api/claude/radio/stations` and picks from it.
 *
 * Note: this is the canonical *named* set, not an allowlist — the POST route
 * still accepts any valid YouTube URL/ID, matching the skill's primary use.
 *
 * STATIONS[0] is the default (Claude FM); keep it first.
 */
export const STATIONS: RadioStation[] = [
  {
    // The official "Claude FM" stream on Anthropic's @claude channel. It is a
    // 24/7 LIVE stream, and YouTube gives a live stream a brand-new video ID
    // every broadcast — so any pinned ID eventually 403s when that broadcast
    // ends (the embed then exhausts its retries and the bar reads "Offline" on
    // a fresh launch, even though the user's connection is fine — the original
    // default YmQ7jRgf4f0 died exactly this way). `refreshClaudeFmDefault()`
    // resolves the channel's *current* live broadcast at gateway boot; the ID
    // pinned here is only the fallback when that resolution fails. Verify a
    // replacement fallback still resolves (oEmbed 200) before swapping it in.
    name: "Claude FM",
    id: "tRsQsTMvPNg",
    tags: ["focus", "ambient", "default", "chill", "build"],
  },
  {
    name: "System Of A Down — Symphonic Orchestra Instrumentals",
    id: "B4levrgre1w",
    tags: ["epic", "cinematic", "instrumental", "rock", "symphonic"],
  },
  {
    name: "Dr. Dre — Symphonic Orchestra Instrumentals",
    id: "Y0umYlXL7uY",
    tags: ["epic", "cinematic", "instrumental", "hip-hop", "symphonic"],
  },
  {
    name: "Linkin Park — Symphonic Orchestra Instrumentals",
    id: "OqjX2v_JBRA",
    tags: ["epic", "cinematic", "instrumental", "rock", "symphonic"],
  },
];

/** Default video — the Claude Radio stream the UI ships pointing at (Claude FM). */
export const DEFAULT_RADIO_VIDEO_ID = STATIONS[0]!.id;

/** Deep copy of the curated station list (callers can't mutate STATIONS). */
export function getStations(): RadioStation[] {
  return STATIONS.map((s) => ({ ...s, tags: [...s.tags] }));
}

export interface RadioState {
  videoId: string;
  /** YouTube video title; null when oEmbed couldn't resolve it. */
  title: string | null;
}

let state: RadioState = { videoId: DEFAULT_RADIO_VIDEO_ID, title: null };

export function getRadio(): RadioState {
  return { ...state };
}

/**
 * Set the radio to the given YouTube URL / video ID. Parses the input,
 * fetches the title from YouTube's oEmbed endpoint (best-effort), and stores
 * the new state in memory. Throws when the input can't be parsed as YouTube.
 */
export async function setRadio(input: string): Promise<RadioState> {
  const videoId = parseYouTubeId(input);
  if (!videoId) {
    throw new Error("Invalid YouTube URL or video ID");
  }
  const title = await fetchTitle(videoId).catch(() => null);
  state = { videoId, title };
  return { ...state };
}

/** Reset to the default stream — used by tests + a "/conan-reset-radio" future skill. */
export function resetRadio(): RadioState {
  state = { videoId: DEFAULT_RADIO_VIDEO_ID, title: null };
  return { ...state };
}

/** Anthropic's @claude channel "live" URL — redirects to whatever broadcast is
 *  currently live. We scrape the canonical video id from it rather than hardcode
 *  a per-broadcast id that rots (see the STATIONS[0] note). */
const CLAUDE_LIVE_URL = "https://www.youtube.com/@claude/live";

/**
 * Resolve the video id of Claude FM's *current* live broadcast by reading the
 * canonical link tag on the channel's `/live` page. Returns null on any failure
 * (offline, non-200, markup change, or the channel simply not live right now —
 * in which case the canonical points at the channel page, has no `?v=`, and the
 * regex misses). Best-effort by design: the caller keeps the pinned fallback.
 */
export async function resolveClaudeFmLiveId(): Promise<string | null> {
  try {
    const r = await fetch(CLAUDE_LIVE_URL, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/,
    );
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Point the radio at Claude FM's current live broadcast. Called once at gateway
 * boot (fire-and-forget). On success it updates the in-memory state AND the
 * curated STATIONS[0] id so the `/conan-change-radio` "default" pick also targets
 * the live broadcast. Returns the new state when the id actually changed (so the
 * caller can broadcast it), else null. Any failure leaves the pinned fallback in
 * place — the radio still plays, just on the last-known-good id.
 */
export async function refreshClaudeFmDefault(): Promise<RadioState | null> {
  const liveId = await resolveClaudeFmLiveId();
  if (!liveId || liveId === state.videoId) return null;
  const title = await fetchTitle(liveId).catch(() => null);
  state = { videoId: liveId, title };
  STATIONS[0]!.id = liveId;
  return { ...state };
}

/**
 * Hostnames we accept a URL from. Anything else — example.com, a sketchy
 * shortener with a youtube-looking path, etc. — is rejected even if the URL
 * structurally contains an 11-char id-shaped token. Includes the standard
 * front-end domains, the privacy-enhanced embed domain, and the short link.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * Parse a YouTube URL, short link, embed link, or bare 11-char video ID.
 * Returns the canonical video ID or null when the input doesn't look like
 * a YouTube source. Critically, URL inputs are restricted to the hostnames
 * in `YOUTUBE_HOSTS` — without that check the regex-only extraction would
 * happily pull an 11-char token from `example.com/watch?v=...` and pass it
 * through, which silently misleads the user about what we accept.
 *
 * Bare 11-char strings are still accepted as a convenience (the YouTube
 * shorthand the URL itself contains) — they're never resolved against any
 * external domain so there's nothing to validate.
 */
export function parseYouTubeId(input: string): string | null {
  const v = input.trim();
  // Bare 11-char ID — accept as a convenience.
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  // URL input — require a YouTube hostname.
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;
  // youtube.com/watch?v=ID
  const q = u.searchParams.get("v");
  if (q && /^[A-Za-z0-9_-]{11}$/.test(q)) return q;
  // youtu.be/ID, youtube.com/live/ID, youtube.com/embed/ID, youtube.com/shorts/ID
  const parts = u.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && /^[A-Za-z0-9_-]{11}$/.test(last)) return last;
  return null;
}

async function fetchTitle(videoId: string): Promise<string | null> {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(
    videoId,
  )}&format=json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { title?: unknown };
    return typeof d.title === "string" && d.title ? d.title : null;
  } catch {
    return null;
  }
}
