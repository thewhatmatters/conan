import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ExternalLink, File, Folder, RotateCcw } from "lucide-react";
import TerminalEngine from "../../components/Terminal.tsx";
import { apiBase } from "../../lib/gateway.ts";
import type { BrowserSurfaceReport } from "../../hooks/useAgentChat.ts";
import { parseUnifiedPatch } from "../../lib/diff.ts";
import V2DiffView from "./V2DiffView.tsx";

const styles = stylex.create({
  body: {
    backgroundColor: "var(--conan-color-content)",
    color: "var(--conan-text-primary)",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "auto",
    width: "100%",
  },
  padded: { padding: "var(--conan-space-4)" },
  fill: { flexGrow: 1, minHeight: 0, minWidth: 0, width: "100%" },
  terminal: {
    backgroundColor: "var(--conan-color-terminal)",
    padding: "var(--conan-space-2)",
  },
  frame: {
    backgroundColor: "var(--conan-color-bg)",
    border: 0,
    height: "100%",
    width: "100%",
  },
  row: {
    borderRadius: "var(--conan-radius-md)",
    justifyContent: "flex-start",
    width: "100%",
  },
  staleNotice: {
    backgroundColor: "var(--conan-wash-hover)",
    borderRadius: "var(--conan-radius-md)",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-3)",
    width: "100%",
  },
  preview: {
    backgroundColor: "var(--conan-color-bg)",
    borderRadius: "var(--conan-radius-md)",
    fontFamily: "var(--conan-font-mono)",
    overflow: "auto",
    padding: "var(--conan-space-3)",
    whiteSpace: "pre-wrap",
  },
});

function CenterState({ children }: { children: string }) {
  return (
    <VStack align="center" justify="center" gap={2} xstyle={[styles.body, styles.padded]}>
      <Text color="secondary">{children}</Text>
    </VStack>
  );
}

export function V2TerminalSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [tid, setTid] = useState(() => crypto.randomUUID());
  const [exited, setExited] = useState(false);
  const killOnUnmount = useRef(true);
  if (!token) return <CenterState>Connecting to the shell…</CenterState>;
  if (exited) {
    return (
      <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
        <Text weight="semibold">Shell exited</Text>
        <Text color="secondary">Restart to open a fresh shell in this workspace.</Text>
        <Button
          label="Restart shell"
          icon={<RotateCcw size={16} aria-hidden />}
          variant="secondary"
          clickAction={() => {
            setTid(crypto.randomUUID());
            setExited(false);
          }}
        />
      </VStack>
    );
  }
  return (
    <VStack xstyle={[styles.body, styles.terminal]}>
      <TerminalEngine
        key={tid}
        token={token}
        theme="dark"
        tid={tid}
        mode="shell"
        cwd={cwd ?? undefined}
        closeOnUnmount={killOnUnmount}
        onExit={() => setExited(true)}
      />
    </VStack>
  );
}

/**
 * The Browser surface (WHA-109).
 *
 * Two things this must get right, both learned the hard way in v1
 * (`ui/src/components/BrowserSurface.tsx`, whose state machine this ports):
 *
 * 1. **Refusal is invisible client-side.** Chrome fires the iframe `load` event
 *    even for frames blocked by X-Frame-Options/CSP, deliberately, so you
 *    cannot tell "rendered" from "refused" from inside the page. The gateway
 *    probe (`GET /api/browser/probe`) reads the headers and answers honestly;
 *    without it this surface is a blank rectangle with no explanation.
 * 2. **The page is opaque to us.** Cross-origin means no title, no text, no
 *    selection — so the title shown here and reported to the agent comes from
 *    the gateway's own fetch (`GET /api/browser/read`), not from the frame.
 *
 * `onStateChange` is what makes the surface a context source: it reports the
 * live URL/title (or the failure) so a turn can carry the auto-context line.
 */
type BrowserView =
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

/** Bare hosts ("localhost:5173") get a scheme; full URLs pass through. */
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

export function V2BrowserSurface({
  token,
  active = false,
  onStateChange,
}: {
  token: string | null;
  /** True when Browser is the visible surface — gates the auto-context line. */
  active?: boolean;
  onStateChange?: (state: BrowserSurfaceReport) => void;
}) {
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<BrowserView>({ kind: "empty" });
  const [title, setTitle] = useState<string | null>(null);
  // Bumped per navigation so Refresh remounts the frame even for the same URL.
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  // A cross-origin frame fires `load` on every navigation inside it but never
  // tells us where it went (verified: the second load fires, reading
  // contentWindow.location throws). So we can know the user has moved off the
  // URL in the bar without knowing their new one — which is exactly enough to
  // stop describing the wrong page.
  const [navigatedAway, setNavigatedAway] = useState(false);
  const frameLoads = useRef(0);
  // Guards async probe/read results against a newer navigation having started.
  const navSeq = useRef(0);

  const navigate = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      const seq = ++navSeq.current;
      setDraft(url);
      setTitle(null);
      setView({ kind: "checking", url });
      let probe: ProbeResult | null = null;
      try {
        const response = await fetch(
          `${apiBase()}/api/browser/probe?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`,
          { headers: { "x-conan-token": token ?? "" } },
        );
        if (response.ok) probe = (await response.json()) as ProbeResult;
      } catch {
        // Probe unavailable (stale gateway) — fall through to the load-timeout
        // heuristic, which is the only signal left in that case.
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
      frameLoads.current = 0;
      setNavigatedAway(false);
      setFrameKey((key) => key + 1);
      setView({ kind: "ok", url });
      // The title can only come from the gateway — a cross-origin frame will
      // not give it up. Best-effort: a failed read just leaves the URL alone.
      try {
        const response = await fetch(
          `${apiBase()}/api/browser/read?url=${encodeURIComponent(url)}`,
          { headers: { "x-conan-token": token ?? "" } },
        );
        if (response.ok) {
          const snapshot = (await response.json()) as { title?: string | null };
          if (seq === navSeq.current && snapshot.title) setTitle(snapshot.title);
        }
      } catch {
        // Title stays null; the surface and the agent both fall back to the URL.
      }
    },
    [token],
  );

  // Load-timeout heuristic: if the frame never fires `load`, stop claiming
  // progress. With the probe vetting first this is belt-and-braces; without it
  // (stale gateway) it is the only failure signal there is.
  useEffect(() => {
    if (view.kind !== "ok" || !frameLoading) return;
    const url = view.url;
    const timer = setTimeout(() => {
      setFrameLoading(false);
      setView({ kind: "unreachable", url, reason: "the page never finished loading" });
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [view, frameLoading, frameKey]);

  // Report upward so the next turn can name this page. Failures report their
  // reason as `problem`, so the model is told the page did not load rather
  // than being handed a URL whose contents nobody can see.
  useEffect(() => {
    if (!onStateChange) return;
    const problem =
      view.kind === "refused" || view.kind === "unreachable"
        ? view.reason ?? "the page could not be displayed"
        : null;
    onStateChange({
      url: view.kind === "empty" ? null : view.url,
      active,
      title: view.kind === "ok" && !navigatedAway ? title : null,
      problem,
      navigatedAway: view.kind === "ok" && navigatedAway,
      // `checking` reports as loading rather than as a live page: the probe has
      // no verdict yet, and a turn sent inside that window must not be told a
      // page is on screen that may still resolve to a refusal.
      loading: view.kind === "checking",
    });
  }, [view, title, active, navigatedAway, onStateChange]);

  const currentUrl = view.kind === "empty" ? null : view.url;
  const go = useCallback(() => void navigate(draft), [draft, navigate]);

  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      <HStack gap={2} align="end">
        <TextInput
          label="URL"
          isLabelHidden
          value={draft}
          placeholder="localhost:5173 or https://…"
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          width="100%"
        />
        <Button label="Open" variant="secondary" clickAction={go} />
        <Button
          label="Refresh"
          icon={<RotateCcw size={16} aria-hidden />}
          variant="ghost"
          isDisabled={!currentUrl}
          clickAction={() => {
            if (currentUrl) void navigate(currentUrl);
          }}
        />
      </HStack>

      {view.kind === "empty" ? (
        <CenterState>Enter a URL to preview it inside Conan.</CenterState>
      ) : null}

      {view.kind === "checking" ? (
        <VStack align="center" justify="center" xstyle={styles.body}>
          <Spinner label={`Checking ${view.url}`} />
        </VStack>
      ) : null}

      {view.kind === "refused" ? (
        <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
          <Text weight="semibold">This site refuses to be embedded</Text>
          <Text color="secondary">
            {view.reason ? `${view.reason}.` : "Its headers forbid framing."} Conan previews
            local apps — full-site browsing needs the native webview.
          </Text>
          <Button
            label="Open in system browser"
            icon={<ExternalLink size={16} aria-hidden />}
            variant="secondary"
            clickAction={() => {
              window.open(view.url, "_blank", "noopener,noreferrer");
            }}
          />
        </VStack>
      ) : null}

      {view.kind === "unreachable" ? (
        <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
          <Text weight="semibold">Couldn't reach that URL</Text>
          <Text color="secondary">
            {view.url}
            {view.reason ? ` — ${view.reason}` : ""}
          </Text>
          <Button
            label="Retry"
            icon={<RotateCcw size={16} aria-hidden />}
            variant="secondary"
            clickAction={() => void navigate(view.url)}
          />
        </VStack>
      ) : null}

      {/* Randy's report: the URL bar silently kept showing the page he STARTED
          on after he followed links inside Wikipedia. We cannot read the new
          URL from a cross-origin frame, so the fix is to stop implying we
          know it — say so to the user, and to the agent (navigatedAway). */}
      {view.kind === "ok" && navigatedAway ? (
        <VStack xstyle={styles.staleNotice} data-slot="browser-stale-url">
          <Text type="supporting" color="secondary">
            You've followed a link inside this page. Conan can't read the current
            address — the bar still shows where you started. Paste the page's URL
            above to re-sync it, and to let the agent read it.
          </Text>
        </VStack>
      ) : null}

      {view.kind === "ok" ? (
        <VStack xstyle={styles.fill}>
          <iframe
            key={frameKey}
            src={view.url}
            title={title ?? "Browser surface"}
            onLoad={() => {
              setFrameLoading(false);
              // The first load is the URL we asked for; any later one is the
              // user following a link inside the page.
              frameLoads.current += 1;
              if (frameLoads.current > 1) setNavigatedAway(true);
            }}
            {...stylex.props(styles.frame)}
          />
        </VStack>
      ) : null}
    </VStack>
  );
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}
interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  error?: string;
}

export function V2FilesSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [path, setPath] = useState(cwd);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => setPath(cwd), [cwd]);
  useEffect(() => {
    if (!token || !path) return;
    let cancelled = false;
    fetch(apiBase() + `/api/fs/list?path=${encodeURIComponent(path)}`, {
      headers: { "x-conan-token": token },
    })
      .then((response) => response.json())
      .then((data: FileListing) => {
        if (!cancelled) setListing(data);
      })
      .catch(() => {
        if (!cancelled) setListing({ path, parent: null, entries: [], error: "Could not read folder." });
      });
    return () => {
      cancelled = true;
    };
  }, [path, token]);
  const openFile = useCallback(
    async (entry: FileEntry) => {
      if (!token) return;
      const response = await fetch(
        apiBase() + `/api/fs/read?path=${encodeURIComponent(entry.path)}`,
        { headers: { "x-conan-token": token } },
      );
      const data = (await response.json()) as { content?: string };
      setPreview({ path: entry.path, content: data.content ?? "This file cannot be previewed." });
    },
    [token],
  );
  if (!token || !path) return <CenterState>Select a thread to browse its files.</CenterState>;
  if (!listing) return <CenterState>Loading files…</CenterState>;
  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      <HStack gap={2} align="center">
        {listing.parent ? (
          <Button label="Parent folder" variant="ghost" size="sm" clickAction={() => setPath(listing.parent)} />
        ) : null}
        <Text color="secondary">{preview?.path ?? listing.path}</Text>
      </HStack>
      {preview ? (
        <VStack gap={2} xstyle={styles.fill}>
          <Button label="Back to files" variant="ghost" size="sm" clickAction={() => setPreview(null)} />
          <Text xstyle={styles.preview}>{preview.content}</Text>
        </VStack>
      ) : listing.error ? (
        <CenterState>{listing.error}</CenterState>
      ) : (
        <VStack gap={1}>
          {listing.entries.map((entry) => (
            <Button
              key={entry.path}
              label={entry.name}
              icon={entry.isDir ? <Folder size={16} aria-hidden /> : <File size={16} aria-hidden />}
              variant="ghost"
              size="sm"
              xstyle={styles.row}
              clickAction={() => (entry.isDir ? setPath(entry.path) : void openFile(entry))}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

interface DiffFile {
  path: string;
  patch: string;
}

export function V2DiffSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token || !cwd) return;
    let cancelled = false;
    fetch(apiBase() + "/api/fs/diff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token },
      body: JSON.stringify({ cwd }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load changes.");
        return response.json() as Promise<{ repo: boolean; files: DiffFile[] }>;
      })
      .then((data) => {
        if (!cancelled) setFiles(data.files);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, token]);
  const parsed = useMemo(
    () => files?.map((file) => ({ ...file, diff: parseUnifiedPatch(file.path, file.patch) })),
    [files],
  );
  if (!token || !cwd) return <CenterState>Select a thread to review changes.</CenterState>;
  if (error) return <CenterState>{error}</CenterState>;
  if (!parsed) {
    return (
      <VStack align="center" justify="center" xstyle={styles.body}>
        <Spinner label="Loading changes" />
      </VStack>
    );
  }
  if (parsed.length === 0) return <CenterState>No uncommitted changes.</CenterState>;
  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      {parsed.map((file) => (
        <VStack key={file.path} gap={2}>
          <Text weight="semibold">{file.path}</Text>
          <V2DiffView diff={file.diff} />
        </VStack>
      ))}
    </VStack>
  );
}
