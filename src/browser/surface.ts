/**
 * Active-Browser-surface state, per agent session (WHA-109).
 *
 * The renderer owns what the Browser surface is showing; the gateway needs it
 * for two jobs — the auto-context block prepended to each turn, and the
 * `read_browser` tool in ./mcp.ts. So the surface reports its state up the existing
 * `/ws/agent` socket and the gateway holds the latest frame per session.
 *
 * State is deliberately in-memory and socket-scoped. A browser surface is
 * ephemeral UI, not a fact worth persisting: when the socket closes the thread
 * is gone from the screen, and a stale URL surviving into a later session would
 * be worse than no context at all.
 */

/** What the renderer reports about its Browser surface. */
export interface BrowserSurfaceState {
  /** Normalized URL currently loaded, or null when the surface is empty. */
  url: string | null;
  /**
   * Whether the Browser surface is the visible/active surface for this thread.
   * A docked-but-hidden surface still reports its URL; auto-context only fires
   * when it is genuinely on screen, per the ticket.
   */
  active: boolean;
  /**
   * Page title. The renderer cannot read this from a cross-origin iframe, so
   * it arrives from the gateway's own fetch (`readPage`) and is echoed back
   * here; null when unknown.
   */
  title: string | null;
  /**
   * Set when the surface knows the page did not render — the gateway probe
   * said refused/unreachable. Auto-context reports the failure rather than
   * naming a URL the user cannot actually see.
   */
  problem: string | null;
  /**
   * The URL is being probed and nothing is on screen for it yet. Its own state
   * rather than an absence, because the alternative is a lie in both
   * directions: reporting the new URL as live claims a page that may turn out
   * to be refused, and reporting the old one names a page the user has already
   * navigated away from. A user can type and send during the probe — that
   * window is up to the probe timeout — so it has to be represented.
   */
  loading: boolean;
  /**
   * The user followed a link INSIDE the framed page, so `url` is where they
   * started, not where they are. A cross-origin frame fires `load` on each
   * internal navigation but never surrenders its new location, so this is the
   * whole of what Conan can know: that the URL went stale.
   *
   * It exists because the alternative shipped a confident lie — a reader
   * navigated Wikipedia's portal to an article, and the model described the
   * portal in detail while the article was on screen.
   */
  navigatedAway: boolean;
}

export const EMPTY_SURFACE: BrowserSurfaceState = {
  url: null,
  active: false,
  title: null,
  problem: null,
  loading: false,
  navigatedAway: false,
};

/**
 * Validate an untrusted `browser-surface` frame off the socket. Returns null
 * when the frame is unusable, so a malformed report leaves the last good state
 * alone instead of blanking it.
 */
export function parseSurfaceFrame(value: unknown): BrowserSurfaceState | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  const rawUrl = typeof frame.url === "string" ? frame.url.trim() : "";
  let url: string | null = null;
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    // Only the two schemes the surface can load. Rejecting the rest keeps
    // `file:`/`data:` URLs from riding this channel into the model's context.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    url = parsed.href;
  }
  const title = typeof frame.title === "string" && frame.title.trim() ? frame.title.trim() : null;
  const problem =
    typeof frame.problem === "string" && frame.problem.trim() ? frame.problem.trim() : null;
  return {
    url,
    active: frame.active === true,
    title,
    problem,
    loading: frame.loading === true,
    navigatedAway: frame.navigatedAway === true,
  };
}

/** Bound on the title we echo into a prompt — a hostile page controls it. */
const MAX_TITLE_CHARS = 200;

/**
 * The ambient context block prepended to a turn, or null when there is nothing
 * worth saying. Kept to one or two lines by design: the ticket is explicit that
 * page text and screenshots are never auto-sent, only fetched on demand through
 * the tool, so this block orients the model without spending its context.
 */
export function browserContextBlock(state: BrowserSurfaceState): string | null {
  if (!state.active || !state.url) return null;
  // Ordered before `problem`: a URL still being probed has no verdict yet, and
  // claiming either "it loaded" or "it failed" would be a guess.
  if (state.loading) {
    return `Active browser surface: ${state.url} — still loading, nothing is on screen for it yet. Do not describe its contents; call mcp__conan__read_browser if you need to know what is at that URL.`;
  }
  // Ahead of everything but `loading`: a stale URL is worse than no URL,
  // because the model will describe it confidently and be wrong.
  if (state.navigatedAway) {
    return `Active browser surface: the user opened ${state.url} and has since followed links inside it. Conan cannot see which page is displayed now (the frame is cross-origin). Do NOT describe or summarize the page — ${state.url} is where they started, not where they are. Ask the user for the current URL, or ask them to paste it into the Browser surface's URL bar.`;
  }
  if (state.problem) {
    return `Active browser surface: ${state.url} — this page did not load (${state.problem}). Do not describe its contents.`;
  }
  const title = state.title ? clip(state.title, MAX_TITLE_CHARS) : null;
  const headline = title
    ? `Active browser surface: ${title} — ${state.url}`
    : `Active browser surface: ${state.url}`;
  // Names the tool as the CLI actually exposes it — MCP namespaces every tool
  // as mcp__<server>__<name>, so a bare `read_browser` would be a hint the
  // model has to guess its way past.
  return `${headline}\n(The user is looking at this page. Its text was not sent — call mcp__conan__read_browser to read it.)`;
}

/** Prepend the block to a turn's text, clearly fenced off from the user's words. */
export function withBrowserContext(text: string, state: BrowserSurfaceState): string {
  const block = browserContextBlock(state);
  if (!block) return text;
  return `${block}\n\n${text}`;
}

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
