/**
 * WHA-104 — the breadcrumb's thread switcher (design: WHA-77).
 *
 * Two layers, because the failure modes are different:
 *   - the LEAF itself (render `Breadcrumb` directly): when the switcher exists
 *     at all, what the open menu exposes, and the keyboard contract;
 *   - the WIRING (render `AppV2` against a stubbed gateway): that the menu is
 *     fed the open project's threads in the sidebar's order, and that picking
 *     one actually moves the chat — the same proof the sidebar-selection test
 *     uses, a transcript request for the newly-selected session.
 *
 * What is NOT asserted here: anchoring, layout shift, and the chevron's paint.
 * jsdom neither lays out nor paints, so those belong to the browser pass.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Breadcrumb, {
  BREADCRUMB_TITLE_MAX_CHARS,
  truncateBreadcrumbTitle,
} from "../components/Breadcrumb.tsx";
import AppV2 from "../App.v2.tsx";

const ANALYZE = { id: "s-analyze", title: "Analyze my project" };
const VALIDATE = { id: "s-validate", title: "Code Validation" };
const SHIP = { id: "s-ship", title: "Ship the release" };
const THREADS = [ANALYZE, VALIDATE, SHIP];

/** A first-message title longer than the 64-char product cap. */
const LONG_TITLE =
  'In notes.md change "Ship the widget" to "Ship the widget v2" and add a fourth goal about QA coverage for the breadcrumb switcher';
const LONG = { id: "s-long", title: LONG_TITLE };

function renderSwitcher(overrides: Parameters<typeof Breadcrumb>[0] = {}) {
  const onSelectThread = vi.fn();
  render(
    <Breadcrumb
      project="conan"
      thread="Analyze my project"
      threads={THREADS}
      activeThreadId="s-analyze"
      onSelectThread={onSelectThread}
      {...overrides}
    />,
  );
  return { onSelectThread };
}

function openSwitcher(name = "Analyze my project") {
  const trigger = screen.getByRole("button", { name });
  fireEvent.click(trigger);
  return trigger;
}

describe("Breadcrumb thread switcher", () => {
  it("keeps the leaf static text when there is nothing to switch to", () => {
    // One thread means the only row would be the thread you are already in.
    render(
      <Breadcrumb
        project="conan"
        thread="Analyze my project"
        threads={[ANALYZE]}
        activeThreadId="s-analyze"
        onSelectThread={() => {}}
      />,
    );

    expect(screen.getByText("Analyze my project")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Analyze my project" }),
    ).not.toBeInTheDocument();
  });

  it("stays static text when the shell passes no selection handler", () => {
    render(
      <Breadcrumb project="conan" thread="Analyze my project" threads={THREADS} />,
    );

    expect(
      screen.queryByRole("button", { name: "Analyze my project" }),
    ).not.toBeInTheDocument();
  });

  it("turns the thread crumb into a menu button once siblings exist", () => {
    renderSwitcher();

    const trigger = screen.getByRole("button", { name: "Analyze my project" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The parent crumb keeps its own job — this is a second control, not a
    // replacement for "back to project".
    expect(screen.getByRole("button", { name: "Back to conan" })).toBeInTheDocument();
  });

  it("lists the project's threads in the order it was given them", () => {
    renderSwitcher();
    const trigger = openSwitcher();

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const rows = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Analyze my project",
      "Code Validation",
      "Ship the release",
    ]);
  });

  it("marks the open thread as the checked one", () => {
    renderSwitcher({ activeThreadId: "s-validate" });
    openSwitcher();

    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitemradio", { name: "Code Validation" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    for (const other of ["Analyze my project", "Ship the release"]) {
      expect(menu.getByRole("menuitemradio", { name: other })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
  });

  // Randy's call, 2026-08-04: the mark is the artboard's trailing check, not
  // Astryx's leading radio dot — and ONLY on the current row. The a11y state
  // above rides the same row, which is the whole reason the row is hand-built.
  it("draws the mark as a check after the title, on the current row only", () => {
    renderSwitcher({ activeThreadId: "s-validate" });
    openSwitcher();

    const rows = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    const marks = rows.map((row) => row.querySelectorAll("svg").length);
    expect(marks).toEqual([0, 1, 0]);

    const current = rows[1];
    if (!current) throw new Error("no current row");
    const mark = current.querySelector("svg");
    const title = current.textContent ?? "";
    expect(title).toBe("Code Validation");
    // Trailing, not leading: the mark follows the title in DOM order.
    expect(
      current.compareDocumentPosition(mark!) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    const label = [...current.querySelectorAll("*")].find(
      (node) => node.textContent === "Code Validation" && node.querySelector("svg") === null,
    );
    expect(
      label!.compareDocumentPosition(mark!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reports the picked sibling's id and closes", async () => {
    const { onSelectThread } = renderSwitcher();
    const trigger = openSwitcher();

    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitemradio", {
        name: "Ship the release",
      }),
    );

    expect(onSelectThread).toHaveBeenCalledWith("s-ship");
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("opens on ArrowDown, moves with the arrows, and Esc gives focus back", async () => {
    const { onSelectThread } = renderSwitcher();
    const trigger = screen.getByRole("button", { name: "Analyze my project" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const menu = within(screen.getByRole("menu"));
    const first = menu.getByRole("menuitemradio", { name: ANALYZE.title });
    const second = menu.getByRole("menuitemradio", { name: VALIDATE.title });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelectThread).toHaveBeenCalledWith("s-validate");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveFocus();
    });
  });

  // Randy 2026-08-04: 64-char hard cap so the switcher can hug content without
  // one runaway first-message title sizing the panel.
  it("truncates leaf and menu titles past 64 characters", () => {
    expect(LONG_TITLE.length).toBeGreaterThan(BREADCRUMB_TITLE_MAX_CHARS);
    const clipped = truncateBreadcrumbTitle(LONG_TITLE);
    expect(clipped.length).toBe(BREADCRUMB_TITLE_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toBe(LONG_TITLE);

    renderSwitcher({
      thread: LONG_TITLE,
      threads: [LONG, ANALYZE],
      activeThreadId: "s-long",
    });

    // Leaf uses the clipped string as both visible text and accessible name.
    const trigger = screen.getByRole("button", { name: clipped });
    expect(trigger).toHaveTextContent(clipped);
    expect(screen.queryByRole("button", { name: LONG_TITLE })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const rows = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual([clipped, ANALYZE.title]);
    // Picking still keys off the real id — truncation is display-only.
    fireEvent.click(rows[1]!);
  });

  it("leaves titles at or under 64 characters untouched", () => {
    const exact = "x".repeat(BREADCRUMB_TITLE_MAX_CHARS);
    expect(truncateBreadcrumbTitle(exact)).toBe(exact);
    expect(truncateBreadcrumbTitle("Short")).toBe("Short");
  });
});

/* -------------------------------------------------------------------------
 * Shell wiring
 * ---------------------------------------------------------------------- */

const CONFIG = { token: "tok", cwd: "/repo/conan", port: 3800 };

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
      {
        sessionId: "s-validate",
        cwd: "/repo/conan",
        model: "opus",
        provider: "claude",
        effort: null,
        title: "Code Validation",
        lastMessage: "Check the gates...",
        createdAt: 2,
        lastActivity: 8,
      },
    ],
  },
  {
    id: "p2",
    path: "/repo/other",
    name: "other",
    createdAt: 2,
    threads: [
      {
        sessionId: "s-elsewhere",
        cwd: "/repo/other",
        model: null,
        provider: "claude",
        effort: null,
        title: "Someone else's work",
        lastMessage: "…",
        createdAt: 3,
        lastActivity: 7,
      },
    ],
  },
];

beforeAll(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGateway() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
    if (url.includes("/api/config")) return body(CONFIG);
    if (url.includes("/api/agent/projects") && !init?.method) {
      return body({ projects: PROJECTS });
    }
    if (url.includes("/transcript")) return body({ found: false, items: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openThread(name: string) {
  const row = await screen.findByRole("button", { name });
  fireEvent.click(row);
  return row;
}

describe("AppV2 breadcrumb thread switcher", () => {
  it("offers the open project's threads and switches the chat to the pick", async () => {
    const fetchMock = stubGateway();
    render(<AppV2 />);

    await openThread("Analyze my project: Run serverless code...");

    const trigger = screen.getByRole("button", { name: "Analyze my project" });
    fireEvent.click(trigger);

    const menu = within(screen.getByRole("menu", { name: "Analyze my project" }));
    // Only this project's threads — the sidebar's other project is not a sibling.
    expect(menu.getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual([
      "Analyze my project",
      "Code Validation",
    ]);
    expect(
      menu.getByRole("menuitemradio", { name: "Analyze my project" }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(menu.getByRole("menuitemradio", { name: "Code Validation" }));

    // The durable proof the chat followed the crumb rather than merely
    // repainting the label: the new thread's history is what gets requested.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/agent/threads/s-validate/transcript"),
        ),
      ).toBe(true),
    );
    // …and the sidebar agrees about which row is current.
    expect(
      screen.getByRole("button", { name: "Code Validation: Check the gates..." }),
    ).toHaveAttribute("aria-current", "page");
  });

  // Regression (browser pass): a draft picked from the rail reaches App.v2's
  // fallback branch, which carries no project id. Keying the crumb's group on
  // the project id therefore lost the switcher for the one thread you had just
  // created — the group is found by which group owns the open row instead.
  it("keeps the switcher when the open row is a draft picked from the rail", async () => {
    stubGateway();
    render(<AppV2 />);

    // Every project group renders its own menu into the DOM, so scope the
    // lookup to this project's — and retry the click, since one that lands
    // before React has flushed is swallowed (same shape as App.v2.test.tsx).
    const kebab = await screen.findByRole("button", { name: "Actions for conan" });
    await waitFor(() => {
      if (kebab.getAttribute("aria-expanded") === "true") return;
      fireEvent.click(kebab);
      throw new Error("project menu did not open");
    });
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Actions for conan" })).getByRole(
        "menuitem",
        { name: "New chat" },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New chat: No messages yet" }));

    // `name` as a string is a full match, so this is the crumb trigger and not
    // the draft ROW ("New chat: No messages yet").
    const trigger = screen.getByRole("button", { name: "New chat" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);

    // The draft leads, exactly as it does in the rail.
    expect(
      within(screen.getByRole("menu", { name: "New chat" }))
        .getAllByRole("menuitemradio")
        .map((row) => row.textContent),
    ).toEqual(["New chat", "Analyze my project", "Code Validation"]);
  });

  it("leaves the crumb static in a single-thread project", async () => {
    stubGateway();
    render(<AppV2 />);

    await openThread("Someone else's work: …");

    expect(
      screen.queryByRole("button", { name: "Someone else's work" }),
    ).not.toBeInTheDocument();
  });
});
