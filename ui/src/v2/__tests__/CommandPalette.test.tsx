/**
 * WHA-70 / US-401 — command palette shell.
 *
 * Asserts the Astryx wrapper, VC-1 bootstrap placeholders, default input +
 * footer hints, and the App.v2 ⌘K + sidebar Search openers.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import V2CommandPalette, {
  VC1_PLACEHOLDERS,
} from "../command/CommandPalette.tsx";
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

describe("V2CommandPalette (shell)", () => {
  it("renders the dialog with default input, footer hints, and VC-1 placeholders when open", async () => {
    render(<V2CommandPalette isOpen onOpenChange={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText(/Navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/Select/i)).toBeInTheDocument();
    expect(screen.getByText(/Close/i)).toBeInTheDocument();

    for (const item of VC1_PLACEHOLDERS) {
      await waitFor(() => {
        expect(screen.getByText(item.label)).toBeInTheDocument();
      });
    }
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
