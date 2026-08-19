/**
 * WHA-121 — a `New chat` becomes a real thread the moment it is sent.
 *
 * Randy's report: send a prompt in a new chat, the sidebar row still reads
 * "New chat"; navigate to another thread and back and the prompt is gone, as
 * if it were a fresh chat.
 *
 * One cause, three symptoms. A draft is local shell state with no
 * `chat_thread` row. On the first send the gateway writes that row — titled
 * from the prompt — but nothing told the shell, so the row kept the untitled
 * placeholder and `activeThread.sessionId` stayed undefined; with no session
 * id there is nothing for `useV2ThreadHistory` to reconstruct on the way back.
 *
 * `useV2Chat` is mocked because the real one opens a WebSocket, and jsdom has
 * no gateway to report a session id. The mock supplies exactly the one fact
 * the shell was missing — everything else under test is the real shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const chatState = vi.hoisted(() => ({ sessionId: null as string | null }));

vi.mock("../lib/useV2Chat.ts", () => ({
  useV2Chat: () => ({
    items: [],
    send: vi.fn(),
    status: "open" as const,
    busy: false,
    awaitingApproval: false,
    pendingApproval: null,
    pendingApprovals: [],
    respondToApproval: vi.fn(),
    interrupt: vi.fn(),
    contextTokens: null,
    sessionId: chatState.sessionId,
    permissionMode: null,
    setPermissionMode: vi.fn(),
    reportError: vi.fn(),
    reportBrowserSurface: vi.fn(),
    capabilities: null,
  }),
}));

const AppV2 = (await import("../App.v2.tsx")).default;

const SESSION = "sess-42";
const CONFIG = { token: "t", port: 3747, cwd: "/repo/one" };
const PROJECT = { id: "p1", path: "/repo/one", name: "one", createdAt: 1 };

/** The saved thread the gateway writes on first send — titled from the prompt. */
const SAVED = {
  sessionId: SESSION,
  title: "Explain the glass bar",
  lastMessage: "It frosts the pane header.",
  provider: "claude",
  cwd: "/repo/one",
  lastActivity: 10,
  model: null,
  effort: null,
};

/** Flips to the post-send listing once the gateway has written the row. */
let sent = false;
let transcriptRequests: string[] = [];

function stubGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = (data: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
      if (url.includes("/api/config")) return body(CONFIG);
      if (url.includes("/transcript")) {
        transcriptRequests.push(url);
        return body({ found: false, items: [] });
      }
      if (url.includes("/api/agent/projects") && !init?.method) {
        return body({ projects: [{ ...PROJECT, threads: sent ? [SAVED] : [] }] });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    }),
  );
}

async function newChat() {
  // The kebab only exists after mocked /api/agent/projects resolves and the
  // row commits. findBy* defaults to 1s — fine alone, marginal when the rest
  // of the UI suite contends for the event loop (WHA-235).
  const trigger = await screen.findByRole(
    "button",
    { name: "Actions for one" },
    { timeout: 5_000 },
  );
  // Wait until the menu controller has mounted closed, then click once.
  // Re-clicking inside waitFor (the old helper) can toggle the menu shut when
  // aria-expanded has not flushed yet — the loop oscillates instead of converging.
  await waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
  const menu = within(screen.getByRole("menu", { name: "Actions for one" }));
  fireEvent.click(menu.getByRole("menuitem", { name: "New chat" }));
}

/** The socket reports its session id — the moment the draft is promoted. */
function reportSession() {
  sent = true;
  chatState.sessionId = SESSION;
}

beforeEach(() => {
  sent = false;
  transcriptRequests = [];
  chatState.sessionId = null;
  stubGateway();
});
afterEach(() => vi.unstubAllGlobals());

describe("draft promotion (WHA-121)", () => {
  it("renames the row to the gateway's title and lists the thread ONCE", async () => {
    const { rerender } = render(<AppV2 />);
    await newChat();
    expect(await screen.findByRole("button", { name: /New chat: No messages yet/ })).toBeTruthy();

    reportSession();
    rerender(<AppV2 />);

    // The row now carries the real title and preview…
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Explain the glass bar: It frosts the pane header.",
        }),
      ).toBeTruthy();
    });
    // …and appears exactly once. Before the fix the saved row arrived beside
    // the draft, so the same conversation was listed twice.
    expect(
      screen.getAllByRole("button", {
        name: "Explain the glass bar: It frosts the pane header.",
      }),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /New chat: No messages yet/ })).toBeNull();
  });

  it("reopens the promoted row as its saved session, not as a fresh chat", async () => {
    const { rerender } = render(<AppV2 />);
    await newChat();
    reportSession();
    rerender(<AppV2 />);

    const row = await screen.findByRole("button", {
      name: "Explain the glass bar: It frosts the pane header.",
    });
    transcriptRequests = [];
    fireEvent.click(row);

    // Selecting it must resolve to the SAVED thread, which is what gives the
    // reopened view a session id to reconstruct from. Before the fix the
    // lookup missed on the `draft-…` id and fell through to the placeholder
    // branch — no session id, so no history, so the prompt was gone.
    await waitFor(() => {
      expect(
        transcriptRequests.some((url) => url.includes(SESSION)),
        `no transcript fetch for ${SESSION}; saw ${JSON.stringify(transcriptRequests)}`,
      ).toBe(true);
    });
  });
});
