/**
 * Frameability probe for the Browser surface (Conan Surfaces US-007).
 *
 * Chrome deliberately fires the iframe `load` event even for frames blocked by
 * X-Frame-Options/CSP (an anti-probing measure), and a blocked frame's document
 * is as opaque as any legit cross-origin one — so the client alone CANNOT tell
 * "refused to embed" apart from "loaded fine". The gateway can: it fetches the
 * target's response headers and reports whether the page origin is allowed to
 * frame it, giving the surface an honest refusal state instead of a silent
 * blank iframe. The client's load-timeout heuristic remains the fallback when
 * this route is unavailable (stale gateway).
 *
 * The decision is an approximation of the browser's real algorithm — full CSP
 * source matching (wildcards, scheme-only sources) is out of scope; unmatched
 * exotic sources read as refused, which errs on the honest side for v1.
 */

export interface FrameProbe {
  /** The target answered an HTTP request at all. */
  reachable: boolean;
  /** Headers permit embedding from the page origin (meaningless when unreachable). */
  frameable: boolean;
  /** Human-readable refusal/unreachable reason, null when frameable. */
  reason: string | null;
  /** HTTP status of the (post-redirect) response, null when unreachable. */
  status: number | null;
}

const PROBE_TIMEOUT_MS = 5_000;

/** The `frame-ancestors` directive value out of a CSP header, or null. */
export function parseFrameAncestors(csp: string | null): string | null {
  if (!csp) return null;
  const match = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp);
  return match?.[1]?.trim() ?? null;
}

/** Normalize an origin/source token for comparison: lowercase, no trailing slash. */
function normalizeOrigin(s: string): string {
  return s.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Decide frameability from the two governing headers. Per spec, a
 * `frame-ancestors` directive makes the browser ignore X-Frame-Options.
 */
export function decideFrameable(
  xfo: string | null,
  frameAncestors: string | null,
  targetOrigin: string,
  pageOrigin: string,
): { frameable: boolean; reason: string | null } {
  const page = normalizeOrigin(pageOrigin);
  const target = normalizeOrigin(targetOrigin);

  if (frameAncestors) {
    const tokens = frameAncestors
      .split(/\s+/)
      .map((t) => normalizeOrigin(t.replace(/^'|'$/g, "")));
    if (tokens.includes("*")) return { frameable: true, reason: null };
    if (tokens.includes("none"))
      return { frameable: false, reason: "CSP frame-ancestors 'none' forbids embedding" };
    if (tokens.includes("self") && target === page) return { frameable: true, reason: null };
    if (tokens.includes(page)) return { frameable: true, reason: null };
    return {
      frameable: false,
      reason: `CSP frame-ancestors does not allow ${page}`,
    };
  }

  if (xfo) {
    // Multiple/conflicting values (comma-joined) block in real browsers — treat
    // any DENY as deny, and SAMEORIGIN as "only its own origin".
    const value = xfo.toLowerCase();
    if (value.includes("deny"))
      return { frameable: false, reason: "X-Frame-Options: DENY forbids embedding" };
    if (value.includes("sameorigin") && target !== page)
      return {
        frameable: false,
        reason: "X-Frame-Options: SAMEORIGIN only allows its own origin",
      };
    if (value.includes("allow-from") && !value.includes(page))
      return { frameable: false, reason: `X-Frame-Options only allows another origin` };
  }

  return { frameable: true, reason: null };
}

/** Probe a URL's response headers. Never throws — network failure is data. */
export async function probeUrl(url: string, pageOrigin: string): Promise<FrameProbe> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "text/html,*/*" },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return {
      reachable: false,
      frameable: false,
      reason: cause?.message || (error as Error).message || "connection failed",
      status: null,
    };
  }
  // Headers are all we need — drop the body without downloading it.
  void response.body?.cancel().catch(() => {});
  const { frameable, reason } = decideFrameable(
    response.headers.get("x-frame-options"),
    parseFrameAncestors(response.headers.get("content-security-policy")),
    new URL(response.url || url).origin,
    pageOrigin,
  );
  return { reachable: true, frameable, reason, status: response.status };
}
