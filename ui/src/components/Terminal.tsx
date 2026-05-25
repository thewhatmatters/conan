import { useEffect, useRef, type MutableRefObject } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "../lib/terminalTheme.ts";
import { ResilientSocket } from "../lib/resilientSocket.ts";
import type { Theme } from "../hooks/useTheme.ts";

interface TerminalProps {
  /** Gateway auth token (from /api/config) — required for the WS upgrade. */
  token: string;
  /** Current app theme; the xterm theme re-derives from CSS tokens on change. */
  theme: Theme;
  /**
   * Stable per-tab terminal id (US-026). Each tab passes its own, so each owns a
   * distinct pty + WS + ring buffer; a reload/HMR re-attaches to the surviving
   * pty and replays the backlog (US-017/US-018).
   */
  tid: string;
  /**
   * Set true (by the Dock) right before unmounting a tab the user closed, so the
   * cleanup tells the backend to kill the pty now instead of letting it survive
   * the detach grace window (US-026 criterion 3). A reload leaves this false, so
   * the pty survives and re-attaches.
   */
  closeOnUnmount?: MutableRefObject<boolean>;
}

/**
 * A live terminal (US-016): xterm.js in the right dock, sized by FitAddon,
 * rendered via WebGL when available, themed from the app's CSS tokens, and
 * bridged to the node-pty service over the authenticated /ws/terminal socket.
 */
export default function Terminal({ token, theme, tid, closeOnUnmount }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);

  // Mount once: create xterm, connect WS, wire I/O + resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      cursorBlink: true,
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: getTerminalTheme(),
      allowProposedApi: true,
    });
    xtermRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL unavailable — fall back to the DOM/canvas renderer */
    }
    fit.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    // `tid` is the stable per-tab id supplied by the Dock (US-026). Re-using it
    // across a reload/HMR/dropped socket re-attaches to the surviving pty and
    // replays the missed backlog instead of spawning a fresh one (US-017/US-018).

    // Self-healing socket: backoff reconnect on drop, re-attaching the same tid
    // so the server replays the ring buffer (US-018). No app-level heartbeat —
    // pty output frames are raw, so a JSON pong can't be mixed into the stream;
    // we rely on the WS close event, which fires for the reload/dock-hide and
    // gateway-restart cases this targets (footgun #2).
    let firstOpen = true;
    const sock = new ResilientSocket({
      url: () => {
        const params = new URLSearchParams({
          token,
          tid,
          cols: String(term.cols),
          rows: String(term.rows),
        });
        return `${proto}://${location.host}/ws/terminal?${params}`;
      },
      onMessage: (ev) => term.write(ev.data as string),
      onStatus: (status) => {
        if (status === "reconnecting") term.write("\r\n[conan] reconnecting…\r\n");
      },
      onOpen: () => {
        if (!firstOpen) term.write("\r\n[conan] reconnected\r\n");
        firstOpen = false;
        fit.fit();
        sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      },
    });

    const onData = term.onData((data) =>
      sock.send(JSON.stringify({ type: "input", data })),
    );

    const sendResize = () => {
      fit.fit();
      sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      onData.dispose();
      // If the Dock is closing this tab (not just a reload), tell the backend to
      // kill the pty + drop its terminal_session row now (US-026 criterion 3).
      if (closeOnUnmount?.current) {
        sock.send(JSON.stringify({ type: "close" }));
      }
      sock.close();
      term.dispose();
      xtermRef.current = null;
    };
  }, [token, tid]);

  // Re-apply the theme when the app theme toggles. Setting options.theme is the
  // supported path; refresh() forces a redraw so the WebGL renderer's glyph
  // atlas can't keep stale colors.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = getTerminalTheme();
    term.refresh(0, term.rows - 1);
  }, [theme]);

  return <div ref={hostRef} className="h-full w-full" />;
}
