/**
 * Command palette — WHA-70 shell, WHA-71 search source, WHA-72 actions.
 *
 * The shell half (dialog, footer hints, ⌘K and sidebar openers) is WHA-70's and
 * is asserted unchanged. The contents half is Randy's 1T4-0 artboard: an
 * Actions group over Recent Threads, and the "New thread in…" row that
 * navigates to a projects screen INSIDE the palette instead of dismissing it —
 * which is the one behaviour Astryx does not give you for free, since its
 * combobox closes on every select.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import V2CommandPalette from "../command/CommandPalette.tsx";
import SearchInput from "../components/SearchInput.tsx";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubShellFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => CONFIG,
        } as Response);
      }
      if (url.includes("/api/agent/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response);
    }),
  );
}

const PROJECTS = [
  { id: "p1", name: "conan" },
  { id: "p2", name: "marketing" },
];

const THREADS = [
  { id: "s-a", title: "Analyze my project", preview: "Run the skill…", lastActivity: 1 },
  { id: "s-b", title: "Code Validation", preview: "Check the gates…", lastActivity: 2 },
];

function renderPalette(overrides: Partial<Parameters<typeof V2CommandPalette>[0]> = {}) {
  const handlers = {
    onOpenChange: vi.fn(),
    onNewThreadIn: vi.fn(),
    onAddProject: vi.fn(),
    onSelectThread: vi.fn(),
  };
  render(
    <V2CommandPalette
      isOpen
      projects={PROJECTS}
      threads={THREADS}
      activeProject={PROJECTS[0]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("V2CommandPalette shell (WHA-70)", () => {
  it("renders the dialog, the combobox and the footer hints when open", () => {
    renderPalette();

    expect(screen.getByRole("dialog", { name: "Command palette" })).toHaveAttribute("open");
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText(/Navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/Select/i)).toBeInTheDocument();
    expect(screen.getByText(/Close/i)).toBeInTheDocument();
  });

  it("stays closed when isOpen is false", () => {
    const { container } = render(
      <V2CommandPalette isOpen={false} onOpenChange={() => {}} />,
    );
    // Closed <dialog> has no accessible name in jsdom (Astryx leaves it without
    // `open`), so query by the data-slot we attach rather than by role+name.
    const dialog = container.querySelector('[data-slot="command-palette"]');
    expect(dialog).not.toBeNull();
    expect(dialog).not.toHaveAttribute("open");
    expect(dialog).toHaveAttribute("aria-label", "Command palette");
  });
});

describe("V2CommandPalette contents (WHA-71/72, artboard 1T4-0)", () => {
  it("shows the designed placeholder, actions and recent threads before typing", async () => {
    renderPalette();

    expect(
      screen.getByPlaceholderText("Search commands, projects and threads…"),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("New thread in conan")).toBeInTheDocument();
    });
    for (const label of ["New thread in…", "Add project"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Recent threads carry the sidebar's preview line.
    expect(screen.getByText("Analyze my project")).toBeInTheDocument();
    expect(screen.getByText("Run the skill…")).toBeInTheDocument();
    // Section headers come from the auto-grouping, not a hand-rolled list.
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Recent Threads")).toBeInTheDocument();
  });

  it("omits rows the shell gave it no handler for", async () => {
    render(
      <V2CommandPalette
        isOpen
        onOpenChange={() => {}}
        projects={PROJECTS}
        threads={THREADS}
        activeProject={PROJECTS[0]}
        onNewThreadIn={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("New thread in conan")).toBeInTheDocument();
    });
    // No onAddProject / onOpenSettings → no dead rows offering them.
    expect(screen.queryByText("Add project")).not.toBeInTheDocument();
    expect(screen.queryByText("Open settings")).not.toBeInTheDocument();
  });

  it("filters across actions and threads", async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText("New thread in conan")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "valid" },
    });

    await waitFor(() => {
      expect(screen.getByText("Code Validation")).toBeInTheDocument();
    });
    expect(screen.queryByText("New thread in conan")).not.toBeInTheDocument();
  });

  it("runs the action and closes for an ordinary row", async () => {
    const handlers = renderPalette();
    await waitFor(() => {
      expect(screen.getByText("Add project")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Add project"));

    expect(handlers.onAddProject).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens a thread by its own id", async () => {
    const handlers = renderPalette();
    await waitFor(() => {
      expect(screen.getByText("Code Validation")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Code Validation"));

    expect(handlers.onSelectThread).toHaveBeenCalledWith("s-b");
  });

  it("'New thread in…' navigates to the projects screen and does NOT dismiss", async () => {
    const handlers = renderPalette();
    await waitFor(() => {
      expect(screen.getByText("New thread in…")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New thread in…"));

    // The palette stays open — Astryx closes on every select, so the close that
    // follows this one row has to be swallowed. That is the whole trick.
    await waitFor(() => {
      expect(screen.getByText("marketing")).toBeInTheDocument();
    });
    expect(handlers.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByPlaceholderText("Search projects…"),
    ).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();

    // …and picking a project there starts the thread in it.
    fireEvent.click(screen.getByText("marketing"));
    expect(handlers.onNewThreadIn).toHaveBeenCalledWith("p2");
  });
});

describe("SearchInput opener", () => {
  it("is a button that opens on click, not on focus", () => {
    const onOpenPalette = vi.fn();
    render(<SearchInput onOpenPalette={onOpenPalette} />);

    const field = screen.getByRole("button", {
      name: "Search projects and threads",
    });
    expect(field).toHaveAttribute("aria-haspopup", "dialog");
    expect(field.tagName).toBe("BUTTON");

    fireEvent.focus(field);
    expect(onOpenPalette).not.toHaveBeenCalled();

    fireEvent.click(field);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });
});

describe("App.v2 command palette wiring", () => {
  it("opens the palette on mod+k (Ctrl+K in jsdom; ⌘K on Apple)", async () => {
    stubShellFetch();
    const { container } = render(<AppV2 />);
    const dialog = () =>
      container.querySelector('[data-slot="command-palette"]');

    expect(dialog()).not.toHaveAttribute("open");

    // Astryx useHotkeys maps `mod` → meta on Apple, ctrl elsewhere. jsdom's
    // navigator.platform is empty, so this environment is non-Apple → Ctrl+K.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() => {
      expect(dialog()).toHaveAttribute("open");
    });
  });

  it("opens the palette from the sidebar Search button", async () => {
    stubShellFetch();
    const { container } = render(<AppV2 />);
    const dialog = () =>
      container.querySelector('[data-slot="command-palette"]');

    expect(dialog()).not.toHaveAttribute("open");

    fireEvent.click(
      screen.getByRole("button", { name: "Search projects and threads" }),
    );

    await waitFor(() => {
      expect(dialog()).toHaveAttribute("open");
    });
  });
});
