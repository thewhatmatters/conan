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

/** Default video — the Claude Radio live stream the UI ships pointing at. */
export const DEFAULT_RADIO_VIDEO_ID = "YmQ7jRgf4f0";

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
