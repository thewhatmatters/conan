/**
 * AppV2 — the v2 shell. Paper artboard RJ-0 "Application Shell".
 *
 * The shell's contract is a region layout: sidebar beside a main column of
 * toolbar → lifted content well, and the secondary bar is the FIRST thing
 * INSIDE that well rather than part of the toolbar. That placement is a design
 * decision worth pinning (it is what lets the well's 24px corner show), so the
 * test asserts containment, not just presence.
 *
 * Note the title bar: RJ-0 draws one (RK-0) and `App.v2.tsx` deliberately does
 * not render it, because Conan's Tauri window keeps its native chrome. Asserted
 * below so the omission stays a decision instead of decaying into an oversight.
 *
 * p2d (US-501) adds the LIVE-DATA half: with the gateway stubbed, the tree is
 * the user's real projects/threads and selecting one hands the chat a full
 * reopen descriptor. The unreachable-gateway suite below is the shell's
 * cold-boot behaviour (no fetch resolves), which is why it still has to render
 * every region.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppV2 from "../App.v2.tsx";

const CONFIG = { token: "tok", cwd: "/repo/conan", port: 3800 };

beforeAll(() => {
  window.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

const PROJECTS = [
  {
    id: "p1",
    path: "/repo/conan",
    name: "conan",
    createdAt: 1,
    threads: [
      {
        sessionId: "s-analyze",
        cwd: "/repo/conan/ui",
        model: "opus",
        provider: "claude",
        effort: "think",
        title: "Analyze my project",
        lastMessage: "Run serverless code...",
        createdAt: 1,
        lastActivity: 9,
      },
    ],
  },
  {
    id: "p2",
    path: "/repo/empty",
    name: "empty",
    createdAt: 2,
    threads: [],
  },
];

/** Stub only the routes the shell reads; anything else 404s honestly. */
function stubGateway(projects: unknown = PROJECTS, patchOk = true) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
    if (url.includes("/api/config")) return body(CONFIG);
    if (url.includes("/api/agent/projects")) return body({ projects });
    if (url.includes("/transcript")) return body({ found: false, items: [] });
    if (init?.method === "PATCH") {
      return patchOk
        ? body({ ok: true })
        : Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({}),
          } as Response);
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppV2 shell", () => {
  it("renders the sidebar and the toolbar", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="toolbar"]')).not.toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toBeInTheDocument();
  });

  it("seats the secondary bar inside the content well, below the toolbar", () => {
    const { container } = render(<AppV2 />);

    const main = container.querySelector('[data-slot="main"]');
    const toolbar = main?.querySelector('[data-slot="toolbar"]') ?? null;
    const secondaryBar = main?.querySelector('[data-slot="secondary-bar"]') ?? null;

    expect(toolbar).not.toBeNull();
    expect(secondaryBar).not.toBeNull();
    if (!toolbar || !secondaryBar) return;

    // Nesting would mean the bar is part of the toolbar row; it is not — it
    // belongs to the well below, which is what lets the well's corner show.
    expect(toolbar.contains(secondaryBar)).toBe(false);
    expect(
      toolbar.compareDocumentPosition(secondaryBar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the secondary bar's three controls", () => {
    render(<AppV2 />);

    for (const label of ["Actions", "Open", "Commit & Push"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("hosts V2ChatView (ChatLayout) in the content well", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="content"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-view="v2"]')).not.toBeNull();
    expect(
      screen.getByText("Select a thread to start chatting."),
    ).toBeInTheDocument();
  });

  it("says loading, not 'no projects', while the gateway is unreachable", () => {
    const { container } = render(<AppV2 />);

    // Cold boot with nothing answering: an "add your first project" prompt
    // here would be a lie about the user's data.
    expect(container.querySelector('[data-slot="thread-row"]')).toBeNull();
    expect(screen.getByText("Loading projects…")).toBeInTheDocument();
  });

  it("does not paint a second title bar over the native window chrome", () => {
    render(<AppV2 />);

    // RK-0's traffic lights + wordmark are the artboard's mock of macOS chrome.
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});

describe("AppV2 live projects (US-501)", () => {
  it("renders the real projects and their threads", async () => {
    stubGateway();
    render(<AppV2 />);

    await screen.findByRole("button", { name: "Collapse conan" });
    expect(
      screen.getByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    ).toBeInTheDocument();
    // A project with no threads says so rather than looking like a failure.
    expect(screen.getByRole("button", { name: "Collapse empty" })).toBeInTheDocument();
    expect(screen.getByText("No chats yet.")).toBeInTheDocument();
  });

  it("falls back to v1's copy for a thread with no title or preview", async () => {
    stubGateway([
      {
        id: "p1",
        path: "/repo/conan",
        name: "conan",
        createdAt: 1,
        threads: [
          {
            sessionId: "s-blank",
            cwd: "/repo/conan",
            model: null,
            provider: null,
            effort: null,
            title: null,
            lastMessage: null,
            createdAt: 1,
            lastActivity: 1,
          },
        ],
      },
    ]);
    render(<AppV2 />);

    expect(
      await screen.findByRole("button", { name: "New chat: No messages yet" }),
    ).toBeInTheDocument();
  });

  it("says 'no projects' only once an empty list actually came back", async () => {
    stubGateway([]);
    render(<AppV2 />);

    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
  });

  it("selecting a thread opens it — the row goes current and the chat follows", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    const row = await screen.findByRole("button", {
      name: "Analyze my project: Run serverless code...",
    });
    // The row's identity is the saved session id — the same key the reopen
    // descriptor resumes on.
    expect(row).toHaveAttribute("data-thread-id", "s-analyze");

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByText("conan")).toHaveLength(2);
    expect(screen.getAllByText("Analyze my project").length).toBeGreaterThan(1);
    // The selected session id drives the history request; this is the durable
    // proof the chat followed the row rather than merely repainting selection.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/agent/threads/s-analyze/transcript"),
        ),
      ).toBe(true),
    );
  });

  it("creates one reusable draft in the selected project", async () => {
    stubGateway();
    render(<AppV2 />);

    fireEvent.click(await screen.findByRole("button", { name: "New chat in conan" }));
    expect(screen.getByRole("button", { name: "New chat: No messages yet" })).toBeInTheDocument();
    expect(screen.getAllByText("New chat").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "New chat in conan" }));
    expect(screen.getAllByRole("button", { name: "New chat: No messages yet" })).toHaveLength(1);
  });

  it("exposes the saved-thread kebab without nesting it in the select target", async () => {
    stubGateway();
    render(<AppV2 />);

    const row = await screen.findByRole("button", {
      name: "Analyze my project: Run serverless code...",
    });
    const menu = screen.getByRole("button", { name: "Actions for Analyze my project" });
    expect(row.contains(menu)).toBe(false);
    expect(row.parentElement?.contains(menu)).toBe(true);
  });

  it("keeps the thread kebab visibly anchored while its menu owns focus", async () => {
    stubGateway();
    render(<AppV2 />);

    const trigger = await screen.findByRole("button", {
      name: "Actions for Analyze my project",
    });
    const actions = trigger.closest('[data-slot="thread-actions"]');
    expect(actions).not.toHaveAttribute("data-menu-open");

    fireEvent.click(trigger);

    const firstItem = await screen.findByRole("menuitem", { name: "New thread" });
    await waitFor(() => expect(firstItem).toHaveFocus());
    fireEvent.keyDown(firstItem, { key: "ArrowDown" });

    expect(screen.getByRole("menuitem", { name: "Rename thread" })).toHaveFocus();
    expect(actions).toHaveAttribute("data-menu-open", "true");
  });

  it("round-trips rename through the existing thread route", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    const actions = await screen.findByRole("button", {
      name: "Actions for Analyze my project",
    });
    fireEvent.click(actions);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename thread" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename thread" });
    const input = screen.getByRole("textbox", { name: "Thread title" });
    expect(input).toHaveValue("Analyze my project");
    await waitFor(() => {
      expect(input).toHaveFocus();
      expect(input).toHaveProperty("selectionStart", 0);
      expect(input).toHaveProperty("selectionEnd", "Analyze my project".length);
    });

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/agent/threads/s-analyze") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(dialog).not.toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/agent/threads/s-analyze") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({
      title: "Renamed thread",
    });
  });

  it("keeps a failed rename open with a recoverable inline error", async () => {
    stubGateway(PROJECTS, false);
    render(<AppV2 />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Analyze my project" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename thread" }));
    const input = await screen.findByRole("textbox", { name: "Thread title" });
    fireEvent.change(input, { target: { value: "Still open" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Couldn't rename this thread. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Rename thread" })).toBeInTheDocument();
    expect(input).toHaveValue("Still open");
  });

  it("cancels rename with Escape without sending a PATCH", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Analyze my project" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename thread" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH"),
    ).toBe(false);
  });

  it("round-trips delete through the existing thread route", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Analyze my project" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/agent/threads/s-analyze") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("resolves the selected thread's own cwd, not just the project path", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );

    // The composer's branch poll is the observable proof the descriptor
    // carried the THREAD's cwd (/repo/conan/ui) rather than the project's.
    await waitFor(() => {
      const gitCalls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/api/fs/git"));
      expect(gitCalls.length).toBeGreaterThan(0);
      expect(gitCalls.some((url) => url.includes(encodeURIComponent("/repo/conan/ui")))).toBe(
        true,
      );
    });
  });
});
