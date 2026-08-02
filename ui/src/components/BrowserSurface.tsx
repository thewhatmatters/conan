import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, Globe, Loader2, RotateCw } from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import { Button } from "./ui/button.tsx";

/**
 * The Browser surface (Conan Surfaces US-007): "Open a local app or URL."
 * v1 is the honest iframe path — local dev servers render; most public sites
 * send X-Frame-Options/CSP and refuse to be embedded. Chrome fires `load`
 * even on blocked frames (anti-probing), so refusal is detected via the
 * gateway header probe (GET /api/browser/probe); the iframe load-timeout
 * heuristic is the fallback when the probe route is unavailable (stale
 * gateway). The full-site child-webview browser is v2.
 *
 * Entered-URL state is plain component state: ChatPanes (and their surface
 * windows) are hidden, never unmounted, on thread switch, so the URL and the
 * live iframe survive; closing the window discards them (same lifecycle as
 * every surface).
 */

type ViewState =
  | { kind: "empty" }
  | { kind: "checking"; url: string }
  | { kind: "ok"; url: string }
  | { kind: "refused"; url: string; reason: string | null }
  | { kind: "unreachable"; url: string; reason: string | null };

interface ProbeResult {
  reachable: boolean;
  frameable: boolean;
  reason: string | null;
  status: number | null;
}

/** Bare hosts ("localhost:5173") get an http:// scheme; full URLs pass through. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}

/** Fallback grace for the iframe load event when the probe is unavailable. */
const LOAD_TIMEOUT_MS = 8_000;

export default function BrowserSurface({ token }: { token: string | null }) {
  const [input, setInput] = useState("");
  const [view, setView] = useState<ViewState>({ kind: "empty" });
  // Bumped per navigation so refresh remounts the iframe even for the same URL.
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  // Guards async probe results against a newer navigation having started.
  const navSeq = useRef(0);

  const navigate = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      const seq = ++navSeq.current;
      setInput(url);
      setView({ kind: "checking", url });
      let probe: ProbeResult | null = null;
      try {
        const r = await fetch(
          `${apiBase()}/api/browser/probe?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`,
          { headers: { "x-conan-token": token ?? "" } },
        );
        if (r.ok) probe = (await r.json()) as ProbeResult;
      } catch {
        // Probe unavailable (stale gateway) — fall through to the iframe
        // load-timeout heuristic below.
      }
      if (seq !== navSeq.current) return;
      if (probe && !probe.reachable) {
        setView({ kind: "unreachable", url, reason: probe.reason });
        return;
      }
      if (probe && !probe.frameable) {
        setView({ kind: "refused", url, reason: probe.reason });
        return;
      }
      setFrameLoading(true);
      setFrameKey((k) => k + 1);
      setView({ kind: "ok", url });
    },
    [token],
  );

  // Load-timeout heuristic: if the frame never fires `load`, stop claiming
  // progress and read as unreachable. With the probe vetting first this is
  // belt-and-braces; without it (stale gateway) it is the only signal.
  useEffect(() => {
    if (view.kind !== "ok" || !frameLoading) return;
    const url = view.url;
    const timer = setTimeout(() => {
      setFrameLoading(false);
      setView({ kind: "unreachable", url, reason: "the page never finished loading" });
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [view, frameLoading, frameKey]);

  const currentUrl = view.kind === "empty" ? null : view.url;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* URL bar — h-9 fixed like every secondary toolbar. */}
      <form
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate(input);
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="http://localhost:5173"
          aria-label="URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-6 min-w-0 flex-1 rounded bg-muted/60 px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          title="Go"
          aria-label="Go"
          disabled={!input.trim()}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => currentUrl && void navigate(currentUrl)}
          title="Refresh"
          aria-label="Refresh"
          disabled={!currentUrl}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {view.kind === "checking" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
        </button>
      </form>

      <div className="relative min-h-0 flex-1">
        {view.kind === "empty" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Globe className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Open a local app</p>
            <p className="max-w-64 text-xs text-muted-foreground">
              Enter a URL above. Browser v1 previews local dev servers — most
              public sites refuse to be embedded.
            </p>
          </div>
        )}

        {view.kind === "checking" && (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking {view.url}…
          </div>
        )}

        {view.kind === "refused" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">
                This site refuses to be embedded
              </p>
              <p className="mx-auto mt-1 max-w-72 text-xs text-muted-foreground">
                {view.reason ? `${view.reason}.` : "Its headers forbid framing."} Browser v1
                previews local apps — full-site browsing arrives with the
                native webview (v2).
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              render={
                <a href={view.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  Open in system browser
                </a>
              }
            />
          </div>
        )}

        {view.kind === "unreachable" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">Couldn't reach that URL</p>
              <p className="mx-auto mt-1 max-w-72 break-all text-xs text-muted-foreground">
                {view.url}
                {view.reason ? ` — ${view.reason}` : ""}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void navigate(view.url)}>
              <RotateCw className="size-3.5" />
              Retry
            </Button>
          </div>
        )}

        {view.kind === "ok" && (
          <>
            {frameLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-card">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <iframe
              key={frameKey}
              src={view.url}
              title="Browser surface"
              onLoad={() => setFrameLoading(false)}
              className="h-full w-full border-0 bg-background"
            />
          </>
        )}
      </div>
    </div>
  );
}
