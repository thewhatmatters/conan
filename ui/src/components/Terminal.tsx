import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "../lib/terminalTheme.ts";
import { THEME_APPLIED_EVENT } from "../lib/themes.ts";
import { ResilientSocket } from "../lib/resilientSocket.ts";
import { wsUrl } from "../lib/gateway.ts";
import type { Theme } from "../hooks/useTheme.ts";
import { useAppearance } from "../hooks/useAppearance.ts";

/** The built-in fallback stack; a picked font is prepended so a missing glyph
 *  still resolves down through Geist Mono → the OS monospaces. */
const FALLBACK_FONTS =
  '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Build the xterm fontFamily from the appearance pref: the chosen family
 *  prepended to the fallback stack, or just the fallback stack when unset. */
function fontStack(picked: string | null): string {
  return picked ? `"${picked}", ${FALLBACK_FONTS}` : FALLBACK_FONTS;
}

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
  const fitRef = useRef<FitAddon | null>(null);
  // Re-fit + tell the pty the new cols/rows. Set during mount so the appearance
  // effect (which lives outside that effect's scope) can drive a reflow.
  const sendResizeRef = useRef<(() => void) | null>(null);
  // Conan appearance pref (shared store) — drives the terminal mono-font family
  // + size. Changing it in Settings notifies every mounted Terminal at once.
  const { appearance } = useAppearance();
  // Edge-fade indicators — true when xterm's viewport isn't at the top/bottom
  // of its scrollback (canScrollUp) or some content lies below it
  // (canScrollDown — only true while the user has scrolled up; live output
  // pins the viewport at the bottom). xterm fires onScroll on every viewport
  // change including auto-follow at the bottom, so the bottom fade
  // self-clears as soon as the user scrolls back to live.
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  // Mount once: create xterm, connect WS, wire I/O + resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      cursorBlink: true,
      fontFamily: fontStack(appearance.terminalFontFamily),
      fontSize: appearance.terminalFontSize,
      theme: getTerminalTheme(),
      allowProposedApi: true,
    });
    xtermRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL unavailable — fall back to the DOM/canvas renderer */
    }
    fit.fit();

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
        return wsUrl(`/ws/terminal?${params}`);
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

    // Edge-fade flags: viewportY > 0 means scrollback is visible above; the
    // bottom fade only lights up when the user has scrolled UP off the live
    // tail (viewportY < baseY). Fires whenever the viewport moves — both user
    // scrolls AND auto-follow on new output, so the bottom fade self-clears
    // as soon as a new line lands and the terminal snaps back to baseY.
    const recomputeFades = () => {
      const buf = term.buffer.active;
      setCanScrollUp(buf.viewportY > 0);
      setCanScrollDown(buf.viewportY < buf.baseY);
    };
    const onScroll = term.onScroll(recomputeFades);
    recomputeFades();

    const sendResize = () => {
      fit.fit();
      sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    sendResizeRef.current = sendResize;
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      onData.dispose();
      onScroll.dispose();
      // If the Dock is closing this tab (not just a reload), tell the backend to
      // kill the pty + drop its terminal_session row now (US-026 criterion 3).
      if (closeOnUnmount?.current) {
        sock.send(JSON.stringify({ type: "close" }));
      }
      sock.close();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      sendResizeRef.current = null;
    };
  }, [token, tid]);

  // Apply the appearance pref live (US-019). Setting term.options.fontFamily/
  // fontSize then re-fitting recomputes glyph cell widths so the layout stays
  // correct; the ResizeObserver-driven sendResize already informs the pty, but
  // we fit() explicitly here since the host box size hasn't changed. Runs on
  // every shared-store change, so changing the font in Settings reskins ALL
  // mounted tabs at once — not just newly opened ones.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.fontFamily = fontStack(appearance.terminalFontFamily);
    term.options.fontSize = appearance.terminalFontSize;
    // Re-fit AND notify the pty (cols/rows may shift with the new glyph size).
    (sendResizeRef.current ?? (() => fitRef.current?.fit()))();
  }, [appearance.terminalFontFamily, appearance.terminalFontSize]);

  // Re-apply the theme whenever a theme is applied (US-021): the apply path
  // dispatches THEME_APPLIED_EVENT after writing the tokens, so a same-type
  // switch (e.g. Dark → Dracula, where the coarse `theme` prop doesn't change)
  // still reskins the terminal. Setting options.theme is the supported path;
  // refresh() forces a redraw so the WebGL renderer's glyph atlas can't keep
  // stale colors. The `theme` prop dependency re-reads on the light/dark flip
  // too (belt-and-suspenders) and re-reads on mount.
  useEffect(() => {
    const reread = () => {
      const term = xtermRef.current;
      if (!term) return;
      term.options.theme = getTerminalTheme();
      term.refresh(0, term.rows - 1);
    };
    reread();
    window.addEventListener(THEME_APPLIED_EVENT, reread);
    return () => window.removeEventListener(THEME_APPLIED_EVENT, reread);
  }, [theme]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {/* Edge fades — sit on top of the xterm viewport so the gradient never
          scrolls with the content. `pointer-events-none` so terminal
          interaction (clicks, drags, text selection) still hits xterm
          underneath. Color matches the terminal bg so the fade reads as
          content dissolving rather than an overlay. */}
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-term-bg to-transparent transition-opacity duration-200 " +
          (canScrollUp ? "opacity-100" : "opacity-0")
        }
      />
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-term-bg to-transparent transition-opacity duration-200 " +
          (canScrollDown ? "opacity-100" : "opacity-0")
        }
      />
    </div>
  );
}
