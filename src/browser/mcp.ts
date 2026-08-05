/**
 * The `read_browser` tool, served to agents over MCP (WHA-109).
 *
 * Conan had no way to give an agent a tool at all: it hosts no MCP server, and
 * each provider hand-builds its own CLI args. The transport chosen here is MCP
 * over streamable HTTP, mounted on the gateway that already exists — no second
 * process, no bundling change, and the browser-surface state the tool needs is
 * already in this process.
 *
 * Sessions are keyed. Each `/ws/agent` connection mints an unguessable key and
 * the CLI is launched pointing at `/mcp/<key>`, so a tool call resolves to
 * exactly the browser surface belonging to that conversation. Without the key
 * there is no ambiguity to get wrong: two threads with two different pages open
 * cannot read each other's.
 *
 * What the tool can honestly answer is shaped by the surface being an iframe:
 * `metadata` and `fullText` are real (the gateway fetches the page itself),
 * while `selection` and `screenshot` are unreachable cross-origin at any effort
 * and say so in the result instead of returning something empty and misleading.
 * Both need the page to be a webview Conan owns rather than a framed document —
 * the Tauri child-webview spike, not this.
 */

import { randomBytes } from "node:crypto";
import { isReadError, readPage } from "./read.js";
import type { BrowserSurfaceState } from "./surface.js";

/** The MCP revision this server implements. */
const PROTOCOL_VERSION = "2025-06-18";

export const READ_BROWSER_SCOPES = ["metadata", "selection", "fullText", "screenshot"] as const;
export type ReadBrowserScope = (typeof READ_BROWSER_SCOPES)[number];

/** Live browser-surface state, read at call time so the tool never goes stale. */
type StateSource = () => BrowserSurfaceState;

const sessions = new Map<string, StateSource>();

/** Register a conversation's surface and get its private MCP path segment. */
export function openBrowserToolSession(getState: StateSource): string {
  const key = randomBytes(24).toString("hex");
  sessions.set(key, getState);
  return key;
}

export function closeBrowserToolSession(key: string): void {
  sessions.delete(key);
}

export function hasBrowserToolSession(key: string): boolean {
  return sessions.has(key);
}

/** Reset between tests. */
export function resetBrowserToolSessions(): void {
  sessions.clear();
}

const TOOL_DEFINITION = {
  name: "read_browser",
  title: "Read the Browser surface",
  description:
    "Read the page currently open in Conan's Browser surface. Use this when the user " +
    "refers to what they are looking at, or asks about a page, preview, or local app on " +
    "screen. `metadata` returns the URL and title; `fullText` returns the page's text. " +
    "The page is read server-side, so it reflects what the server sent, not client-side " +
    "rendering — the result says so when that distinction matters.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: [...READ_BROWSER_SCOPES],
        description:
          "metadata = URL + title (cheap). fullText = the page's text content. " +
          "selection and screenshot are not available on this surface and will say so.",
      },
    },
    required: ["scope"],
    additionalProperties: false,
  },
} as const;

/** A tool result, in MCP's content shape. `isError` marks a refusal, not a crash. */
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * Why `selection` and `screenshot` answer the way they do. Stated in full to
 * the model, because a bare "unsupported" invites it to retry or to guess; the
 * reason tells it what to do instead (ask the user to paste, or describe).
 */
const IFRAME_LIMIT =
  "Conan's Browser surface renders the page in an iframe, so this cannot be read: the " +
  "browser's same-origin policy makes a cross-origin frame opaque to Conan, and that is " +
  "enforced by the browser rather than by a permission Conan can grant.";

export async function callReadBrowser(
  scope: ReadBrowserScope,
  state: BrowserSurfaceState,
): Promise<ToolResult> {
  if (!state.url) {
    return text(
      "The Browser surface has no page open. Ask the user to enter a URL in the Browser " +
        "surface, or use WebFetch if you just need a URL you already know.",
      true,
    );
  }
  if (state.problem) {
    return text(
      `The Browser surface is pointed at ${state.url} but the page did not load: ` +
        `${state.problem}. There is nothing on screen to read — do not describe its contents.`,
      true,
    );
  }

  if (scope === "selection") {
    return text(
      `${IFRAME_LIMIT} To use selected text, ask the user to paste it. (Reading a live ` +
        "selection needs a native webview, which Conan does not use for this surface yet.)",
      true,
    );
  }
  if (scope === "screenshot") {
    return text(
      `${IFRAME_LIMIT} A screenshot has the same limitation — Conan cannot rasterize a ` +
        "cross-origin frame. Use `fullText` to read the page as text instead.",
      true,
    );
  }

  if (scope === "metadata") {
    // Titles come from the surface's own gateway read; fall back to a fresh
    // fetch when the surface never got one (a title-less page reports null and
    // the extra fetch is cheap enough not to special-case).
    const title = state.title ?? (await freshTitle(state.url));
    return text(
      `Active browser surface\nURL: ${state.url}\nTitle: ${title ?? "(the page has no title)"}`,
    );
  }

  const snapshot = await readPage(state.url);
  if (isReadError(snapshot)) {
    return text(
      `Could not read ${state.url}: ${snapshot.error}. The page may still be rendering ` +
        "correctly on screen — this failure is Conan's own fetch of it, not the user's view.",
      true,
    );
  }

  const notes: string[] = [];
  if (snapshot.clientRendered) {
    notes.push(
      "This page renders client-side: the server sent a near-empty shell and the visible " +
        "content is drawn by JavaScript, which this read cannot execute. What follows is " +
        "the shell, NOT what the user sees. Say so rather than treating the page as blank.",
    );
  }
  if (snapshot.truncated) {
    notes.push(`Truncated — the page is longer than the ${snapshot.text.length}-character cap.`);
  }
  if (snapshot.url !== state.url) notes.push(`Redirected to ${snapshot.url}.`);

  const header = [
    `Active browser surface: ${snapshot.title ?? "(no title)"} — ${snapshot.url}`,
    ...notes,
  ].join("\n");
  return text(`${header}\n\n---\n${snapshot.text}`);
}

async function freshTitle(url: string): Promise<string | null> {
  const snapshot = await readPage(url);
  return isReadError(snapshot) ? null : snapshot.title;
}

/** A JSON-RPC response, or null for a notification (nothing to send back). */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Handle one JSON-RPC message for a session. Returns null when the message is a
 * notification. Unknown methods answer with -32601 rather than throwing, so a
 * client probing for optional capabilities (prompts, resources) degrades to
 * "not supported" instead of killing the connection.
 */
export async function handleMcpMessage(
  key: string,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const rpc = message as { id?: string | number; method?: string; params?: unknown };
  const id = rpc.id ?? null;
  const isNotification = rpc.id === undefined;
  const reply = (result: unknown): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: "2.0", id, result };

  switch (rpc.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "conan-browser", version: "1" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL_DEFINITION] });
    case "tools/call": {
      const params = (rpc.params ?? {}) as { name?: string; arguments?: { scope?: unknown } };
      if (params.name !== TOOL_DEFINITION.name) {
        return isNotification
          ? null
          : {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `unknown tool: ${String(params.name)}` },
            };
      }
      const getState = sessions.get(key);
      if (!getState) {
        // The conversation's socket closed while its CLI was still running.
        return reply(
          text(
            "This Conan chat session is no longer connected, so its Browser surface cannot " +
              "be read.",
            true,
          ),
        );
      }
      const scope = params.arguments?.scope;
      if (typeof scope !== "string" || !READ_BROWSER_SCOPES.includes(scope as ReadBrowserScope)) {
        return reply(
          text(
            `scope must be one of: ${READ_BROWSER_SCOPES.join(", ")}. Received: ${JSON.stringify(scope)}`,
            true,
          ),
        );
      }
      return reply(await callReadBrowser(scope as ReadBrowserScope, getState()));
    }
    default:
      return isNotification
        ? null
        : {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${String(rpc.method)}` },
          };
  }
}

/** The `--mcp-config` payload pointing a CLI at this session's tool endpoint. */
export function mcpConfigFor(port: number, key: string): string {
  return JSON.stringify({
    mcpServers: {
      conan: { type: "http", url: `http://127.0.0.1:${port}/mcp/${key}` },
    },
  });
}
