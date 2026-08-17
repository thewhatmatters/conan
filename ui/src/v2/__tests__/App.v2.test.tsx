/**
 * AppV2 — the v2 shell. Paper artboard RJ-0 "Application Shell".
 *
 * The shell's contract is a region layout: sidebar beside a main column of
 * toolbar → lifted content well. WHA-158 puts the Chat/surfaces tab strip in the
 * top toolbar and the chat-surface toolbar (Actions/Open/Commit & Push) as the
 * first thing INSIDE the content well, not part of the toolbar row. That
 * placement is a design decision worth pinning (it is what lets the well's
 * 24px corner show), so the test asserts containment, not just presence.
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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
function stubGateway(
  projects: unknown = PROJECTS,
  patchOk = true,
  deleteOk = true,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
    if (url.includes("/api/config")) return body(CONFIG);
    if (url.includes("/api/sagan/runs")) {
      const valid = url.includes(encodeURIComponent("/repo/conan"));
      return body({
        project: { sagan: { state: valid ? "valid" : "absent" } },
        runs: [],
      });
    }
    // Method-guarded: `/api/agent/projects/:id` is also the DELETE target
    // (WHA-74), and an unguarded prefix match would answer it 200 and hide
    // every remove-failure path.
    if (url.includes("/api/agent/projects") && !init?.method) {
      return body({ projects });
    }
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
    if (init?.method === "DELETE") {
      return deleteOk
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

/**
 * Open a project header's kebab (WHA-74) and return its menu.
 *
 * Every group renders its own DropdownMenu into the DOM, so "New chat" and
 * "Remove project" match once per project. Scope by the menu's own aria-label
 * rather than by open state — the closed ones are present too.
 */
async function openProjectMenu(project: string) {
  const name = `Actions for ${project}`;
  const trigger = await screen.findByRole("button", { name });
  // The menu is controlled by AppV2 state. A click that lands before React has
  // flushed the PREVIOUS close is swallowed, so retry until the trigger itself
  // reports open rather than asserting on one click.
  await waitFor(() => {
    if (trigger.getAttribute("aria-expanded") === "true") return;
    fireEvent.click(trigger);
    throw new Error(`${name} did not open`);
  });
  return within(screen.getByRole("menu", { name }));
}

async function newChatInProject(project: string) {
  const menu = await openProjectMenu(project);
  fireEvent.click(menu.getByRole("menuitem", { name: "New chat" }));
}

async function removeProject(project: string) {
  const menu = await openProjectMenu(project);
  fireEvent.click(menu.getByRole("menuitem", { name: "Remove project" }));
}

describe("AppV2 shell", () => {
  it("renders the sidebar and the toolbar", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="toolbar"]')).not.toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toBeInTheDocument();
  });

  it("seats surface tabs in the toolbar and the chat toolbar inside the content well below", () => {
    const { container } = render(<AppV2 />);

    const main = container.querySelector('[data-slot="main"]');
    const toolbar = main?.querySelector('[data-slot="toolbar"]') ?? null;
    const chatToolbar = container.querySelector('[data-slot="chat-surface-toolbar"]');

    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="surface-tabs"]')).not.toBeNull();
    expect(chatToolbar).not.toBeNull();
    if (!toolbar || !chatToolbar) return;

    // The chat toolbar lives in the well, not in the top toolbar row.
    expect(toolbar.contains(chatToolbar)).toBe(false);
    expect(
      toolbar.compareDocumentPosition(chatToolbar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders Actions/Open/Commit & Push inside the chat surface, and the surface tab strip above", () => {
    render(<AppV2 />);

    expect(screen.getByRole("group", { name: "Chat and surfaces" })).toBeInTheDocument();
    for (const label of ["Actions", "Open", "Commit & Push"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(document.querySelector('[data-slot="chat-surface-toolbar"]')).not.toBeNull();
  });

  it("hosts V2ChatView (ChatLayout) in the content well", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="content"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-view="v2"]')).not.toBeNull();
    expect(
      screen.getByText("Select a thread to start chatting."),
    ).toBeInTheDocument();
  });

  it("opens and closes surfaces as tabs while Chat stays visible", () => {
    render(<AppV2 />);

    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));
    expect(screen.getByRole("button", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close Browser tab"));
    expect(screen.queryByRole("button", { name: "Browser" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
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

  it("removes all Sagan chrome when switching to a non-Sagan project", async () => {
    stubGateway();
    render(<AppV2 />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    await waitFor(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Surface" }));
      expect(
        within(screen.getByRole("menu", { name: "Surface" })).getByRole("menuitem", {
          name: "Sagan",
        }),
      ).toBeVisible();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Sagan" }));
    expect(await screen.findByRole("button", { name: "Sagan" })).toBeInTheDocument();

    await newChatInProject("empty");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Sagan" })).toBeNull();
      expect(document.querySelector('[data-surface="sagan"]')).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    expect(
      within(screen.getByRole("menu", { name: "Surface" })).queryByRole("menuitem", {
        name: "Sagan",
      }),
    ).toBeNull();
  });

  it("creates one reusable draft in the selected project", async () => {
    stubGateway();
    render(<AppV2 />);

    await newChatInProject("conan");
    expect(screen.getByRole("button", { name: "New chat: No messages yet" })).toBeInTheDocument();
    expect(screen.getAllByText("New chat").length).toBeGreaterThan(1);

    await newChatInProject("conan");
    expect(screen.getAllByRole("button", { name: "New chat: No messages yet" })).toHaveLength(1);
  });

  // WHA-103 + WHA-199: right-click on the row still opens the ContextMenu; the
  // hover kebab (click DropdownMenu) is the other path, restored so delete /
  // rename work when Tauri swallows the right-click gesture (WHA-198).
  it("opens the thread menu from a right-click on the row itself", async () => {
    stubGateway();
    render(<AppV2 />);

    const row = await screen.findByRole("button", {
      name: "Analyze my project: Run serverless code...",
    });
    expect(
      screen.getByRole("button", { name: "Actions for Analyze my project" }),
    ).toBeInTheDocument();

    fireEvent.contextMenu(row);

    expect(
      await screen.findByRole("menu", { name: "Actions for Analyze my project" }),
    ).toBeInTheDocument();
  });

  it("opens the thread menu from the hover kebab (WHA-199)", async () => {
    stubGateway();
    render(<AppV2 />);

    const kebab = await screen.findByRole("button", {
      name: "Actions for Analyze my project",
    });
    fireEvent.click(kebab);

    expect(
      await screen.findByRole("menu", { name: "Actions for Analyze my project" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("keeps the menu keyboard-navigable once right-click opens it", async () => {
    stubGateway();
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );

    const firstItem = await screen.findByRole("menuitem", { name: "New thread" });
    await waitFor(() => expect(firstItem).toHaveFocus());
    fireEvent.keyDown(firstItem, { key: "ArrowDown" });

    expect(screen.getByRole("menuitem", { name: "Rename thread" })).toHaveFocus();
  });

  it("round-trips rename through the existing thread route", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
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

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
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

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename thread" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH"),
    ).toBe(false);
  });

  it("guards deletion until the named confirmation is accepted", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(
      await screen.findByRole("alertdialog", { name: "Delete “Analyze my project”?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This removes the thread from Conan. This action can’t be undone."),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete thread" }));
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

  it("keeps the thread when deletion is cancelled", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete “Analyze my project”?",
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Analyze my project: Run serverless code..." }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("keeps the thread when deletion is dismissed with Escape", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete “Analyze my project”?",
    });

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Analyze my project: Run serverless code..." }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("keeps a failed deletion open with recovery copy", async () => {
    stubGateway(PROJECTS, true, false);
    render(<AppV2 />);

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete thread" }));

    expect(
      await screen.findByText("The thread could not be deleted. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("alertdialog", { name: "Delete “Analyze my project”?" }),
    ).toBeInTheDocument();
  });

  it("offers both project actions from the header kebab", async () => {
    stubGateway();
    render(<AppV2 />);

    const menu = await openProjectMenu("conan");

    expect(menu.getByRole("menuitem", { name: "New chat" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Remove project" })).toBeInTheDocument();
  });

  it("guards project removal until the named confirmation is accepted", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    await removeProject("conan");

    expect(
      await screen.findByRole("alertdialog", { name: "Remove “conan”?" }),
    ).toBeInTheDocument();
    // The copy has to state what is NOT deleted, or "remove" reads as rm -rf.
    expect(
      screen.getByText(
        "This removes the project and its threads from Conan. The folder on disk is not deleted. This action can’t be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/agent/projects/p1") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("keeps the project when removal is cancelled", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    await removeProject("conan");
    const dialog = await screen.findByRole("alertdialog", { name: "Remove “conan”?" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Analyze my project: Run serverless code..." }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("keeps the project when removal is dismissed with Escape", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    await removeProject("conan");
    const dialog = await screen.findByRole("alertdialog", { name: "Remove “conan”?" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("keeps a failed project removal open with recovery copy", async () => {
    stubGateway(PROJECTS, true, false);
    render(<AppV2 />);

    await removeProject("conan");
    fireEvent.click(await screen.findByRole("button", { name: "Remove project" }));

    expect(
      await screen.findByText("The project could not be removed. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("alertdialog", { name: "Remove “conan”?" }),
    ).toBeInTheDocument();
  });

  it("drops the removed project's draft instead of stranding it", async () => {
    stubGateway();
    render(<AppV2 />);

    await newChatInProject("conan");
    expect(screen.getByRole("button", { name: "New chat: No messages yet" })).toBeInTheDocument();

    await removeProject("conan");
    fireEvent.click(await screen.findByRole("button", { name: "Remove project" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "New chat: No messages yet" }),
      ).not.toBeInTheDocument(),
    );
  });

  // Randy's report, 2026-08-02: with every project removed, "Add project" did
  // nothing and the shell was unrecoverable. The button had never been wired.
  it("recovers from an empty list: remove the last project, then add one", async () => {
    let current = [PROJECTS[0]];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = (data: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
      if (url.includes("/api/config")) return body(CONFIG);
      if (url.includes("/api/fs/list")) {
        // Echo the requested path — the dialog's cwd tracks the listing it got
        // back, so a stub that always answers "/repo" would silently make the
        // descend step a no-op and let a broken POST target pass.
        const at = decodeURIComponent(
          new URL(url, "http://x").searchParams.get("path") ?? CONFIG.cwd,
        );
        return body({
          path: at,
          parent: "/repo",
          entries: at.endsWith("/fresh")
            ? []
            : [{ name: "fresh", path: `${at}/fresh`, isDir: true }],
        });
      }
      if (url.includes("/api/agent/projects") && init?.method === "DELETE") {
        current = [];
        return body({ deleted: true, worktrees: [] });
      }
      if (url.includes("/api/agent/projects") && init?.method === "POST") {
        current = [
          { id: "p9", path: `${CONFIG.cwd}/fresh`, name: "fresh", createdAt: 3, threads: [] },
        ];
        return body(current[0]);
      }
      if (url.includes("/api/agent/projects")) return body({ projects: current });
      if (url.includes("/transcript")) return body({ found: false, items: [] });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppV2 />);

    await removeProject("conan");
    fireEvent.click(await screen.findByRole("button", { name: "Remove project" }));

    // The empty tree must offer a named way out, not just the header icon.
    const cta = await screen.findByRole("button", { name: "Add your first project" });
    fireEvent.click(cta);

    // Source picker → local folder browser.
    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    // Descend into the only directory, then confirm the current folder with ⌘+Enter.
    fireEvent.click(await screen.findByRole("option", { name: "fresh" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );
    fireEvent.keyDown(document.querySelector('[data-slot="add-project-dialog"]')!, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/agent/projects") &&
            (init as RequestInit | undefined)?.method === "POST" &&
            JSON.parse(String((init as RequestInit).body)).path === `${CONFIG.cwd}/fresh`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("fresh")).toBeInTheDocument();
  });

  it("keeps the add-project dialog open and says so when the add fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = (data: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
      if (url.includes("/api/config")) return body(CONFIG);
      if (url.includes("/api/fs/list")) {
        return body({ path: "/repo", parent: null, entries: [] });
      }
      if (url.includes("/api/agent/projects") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({}) } as Response);
      }
      if (url.includes("/api/agent/projects")) return body({ projects: PROJECTS });
      if (url.includes("/transcript")) return body({ found: false, items: [] });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppV2 />);

    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    await screen.findByText("No folders here.");
    fireEvent.keyDown(document.querySelector('[data-slot="add-project-dialog"]')!, { key: "Enter", metaKey: true });

    expect(
      await screen.findByText("Couldn't add that folder as a project. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeInTheDocument();
  });

  it("reopens the command palette when the folder browser back arrow is pressed", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = (data: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
      if (url.includes("/api/config")) return body(CONFIG);
      if (url.includes("/api/fs/list")) {
        return body({ path: "/repo/conan", parent: null, entries: [] });
      }
      if (url.includes("/api/agent/projects")) return body({ projects: PROJECTS });
      if (url.includes("/transcript")) return body({ found: false, items: [] });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AppV2 />);
    const palette = () => container.querySelector('[data-slot="command-palette"]');

    // Start from the sidebar "Add project" button; back should reopen the palette.
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    await screen.findByRole("dialog", { name: "Add project" });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(palette()).toHaveAttribute("open"));
    expect(
      screen.queryByRole("dialog", { name: "Add project" }),
    ).not.toBeInTheDocument();
  });

  // Found in WHA-74 browser QA: `crypto.randomUUID` is secure-context only, so
  // on a plain-http LAN preview it is undefined and New chat threw instead of
  // creating a draft. Pre-existing, but it made the kebab's own New chat item
  // untestable at the origin reviewers actually use.
  it("creates a draft when crypto.randomUUID is unavailable (insecure origin)", async () => {
    stubGateway();
    // `randomUUID` lives on Crypto.prototype, so `delete crypto.randomUUID` is
    // a no-op and the test would pass with or without the fix. Shadow it with
    // an own property instead, then remove that property to restore.
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(typeof crypto.randomUUID).not.toBe("function");
      render(<AppV2 />);
      await newChatInProject("conan");
      expect(
        await screen.findByRole("button", { name: "New chat: No messages yet" }),
      ).toBeInTheDocument();
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
      expect(typeof crypto.randomUUID).toBe("function");
    }
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
