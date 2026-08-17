/**
 * AddProjectDialog — v2 folder browser (WHA-201 / WHA-202).
 *
 * Covers the source picker, directory listing, keyboard navigation, and the
 * confirm action wired to `POST /api/agent/projects`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddProjectDialog from "../components/AddProjectDialog.tsx";

const START = "/repo";
const CONFIG = { token: "tok", cwd: START, port: 3800 };

beforeAll(() => {
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

function listingFor(path: string): {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isDir: boolean }[];
} {
  if (path === START) {
    return {
      path: START,
      parent: null,
      entries: [
        { name: "conan", path: `${START}/conan`, isDir: true },
        { name: "fresh", path: `${START}/fresh`, isDir: true },
      ],
    };
  }
  if (path === `${START}/conan`) {
    return {
      path: `${START}/conan`,
      parent: START,
      entries: [{ name: "ui", path: `${START}/conan/ui`, isDir: true }],
    };
  }
  if (path === `${START}/fresh`) {
    return {
      path: `${START}/fresh`,
      parent: START,
      entries: [],
    };
  }
  if (path === `${START}/conan/ui`) {
    return {
      path: `${START}/conan/ui`,
      parent: `${START}/conan`,
      entries: [],
    };
  }
  return { path, parent: START, entries: [] };
}

function stubFetch(overrides?: {
  onList?: (path: string) => ReturnType<typeof listingFor>;
  onAdd?: () => { ok: boolean; status: number; body?: unknown };
}) {
  const onList = overrides?.onList ?? listingFor;
  const onAdd =
    overrides?.onAdd ??
    (() => ({ ok: true, status: 200, body: { id: "p1", path: `${START}/conan` } }));

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => CONFIG,
        } as Response);
      }
      if (url.includes("/api/fs/list")) {
        const path =
          new URL(url, "http://x").searchParams.get("path") ?? START;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => onList(path),
        } as Response);
      }
      if (url.includes("/api/agent/projects") && init?.method === "POST") {
        const result = onAdd();
        return Promise.resolve({
          ok: result.ok,
          status: result.status,
          json: async () => result.body ?? {},
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

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {},
) {
  const handlers = {
    onOpenChange: vi.fn(),
    onAdd: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <AddProjectDialog
      isOpen
      token="tok"
      start={START}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

function dialogContainer() {
  return document.querySelector('[data-slot="add-project-dialog"]');
}

describe("AddProjectDialog source picker", () => {
  it("starts on the source picker with a Local folder option", () => {
    stubFetch();
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Add project" })).toHaveAttribute("open");
    const localRow = screen.getByRole("option", { name: "Local folder Browse a folder on disk" });
    expect(localRow).toBeInTheDocument();
    expect(screen.getByText("Browse a folder on disk")).toBeInTheDocument();
    expect(document.activeElement).toBe(localRow);
  });

  it("moves to the folder browser when Local folder is activated", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );

    expect(await screen.findByText("Directories")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
    const conanRow = screen.getByRole("option", { name: "conan" });
    expect(conanRow).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(conanRow));
  });

  it("moves to the folder browser when Local folder is focused and Enter is pressed", async () => {
    stubFetch();
    renderDialog();

    const localRow = await screen.findByRole("option", { name: "Local folder Browse a folder on disk" });
    await waitFor(() => expect(document.activeElement).toBe(localRow));
    fireEvent.keyDown(localRow, { key: "Enter" });

    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));
    expect(screen.getByText("/repo")).toBeInTheDocument();
  });

  it("calls onBack when the back arrow is pressed in the source view", () => {
    stubFetch();
    const onBack = vi.fn();
    const { onOpenChange } = renderDialog({ onBack });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes when the back arrow is pressed in the source view and onBack is omitted", () => {
    stubFetch();
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("AddProjectDialog folder browser", () => {
  it("descends into a directory on click", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "conan" }));

    expect(await screen.findByText("/repo/conan")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ui" })).toBeInTheDocument();
    // The parent directory is the first row; focus must land on a row, not body.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );
  });

  it("descends into the focused directory with ArrowRight", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));

    fireEvent.keyDown(conanRow, { key: "ArrowRight" });

    expect(await screen.findByText("/repo/conan")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );
  });

  it("moves focus onto the first row of the new list after descending", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "conan" }));
    await screen.findByText("/repo/conan");

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );
  });

  it("navigates up with the .. row or Backspace", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "conan" }));
    await screen.findByText("/repo/conan");

    fireEvent.click(screen.getByRole("option", { name: ".." }));
    expect(await screen.findByText("/repo")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "conan" })),
    );

    fireEvent.click(screen.getByRole("option", { name: "conan" }));
    await screen.findByText("/repo/conan");

    fireEvent.keyDown(screen.getByRole("option", { name: "ui" }), { key: "Backspace" });
    expect(await screen.findByText("/repo")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "conan" })),
    );
  });

  it("goes up with ArrowLeft", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));

    fireEvent.keyDown(conanRow, { key: "ArrowRight" });
    await screen.findByText("/repo/conan");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );

    fireEvent.keyDown(screen.getByRole("option", { name: ".." }), { key: "ArrowLeft" });
    expect(await screen.findByText("/repo")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "conan" })),
    );
  });

  it("goes up when Enter is pressed on the .. row", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "conan" }));
    await screen.findByText("/repo/conan");

    fireEvent.keyDown(screen.getByRole("option", { name: ".." }), { key: "Enter" });
    expect(await screen.findByText("/repo")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "conan" })),
    );
  });

  it("returns to the source picker when back is pressed at the root browser", async () => {
    stubFetch();
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    expect(await screen.findByText("/repo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    const localRow = screen.getByRole("option", { name: "Local folder Browse a folder on disk" });
    expect(localRow).toBeInTheDocument();
    expect(screen.queryByText("Directories")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(localRow));
  });

  it("moves selection with arrow keys", async () => {
    stubFetch({
      onList: (path) =>
        path === START
          ? {
              path: START,
              parent: null,
              entries: [
                { name: "a", path: `${START}/a`, isDir: true },
                { name: "b", path: `${START}/b`, isDir: true },
              ],
            }
          : listingFor(path),
    });
    renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    const a = await screen.findByRole("option", { name: "a" });
    const b = await screen.findByRole("option", { name: "b" });

    await waitFor(() => expect(document.activeElement).toBe(a));
    expect(a).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(a, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(b));
    expect(b).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(b, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(a));
    expect(a).toHaveAttribute("aria-selected", "true");
  });

  it("does not leave focus on body after keyboard transitions", async () => {
    stubFetch();
    renderDialog();

    const localRow = await screen.findByRole("option", { name: "Local folder Browse a folder on disk" });
    await waitFor(() => expect(document.activeElement).toBe(localRow));

    fireEvent.keyDown(localRow, { key: "Enter" });
    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));

    fireEvent.keyDown(conanRow, { key: "ArrowDown" });
    const freshRow = await screen.findByRole("option", { name: "fresh" });
    await waitFor(() => expect(document.activeElement).toBe(freshRow));

    fireEvent.keyDown(freshRow, { key: "ArrowRight" });
    await screen.findByText("/repo/fresh");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: ".." })),
    );

    fireEvent.keyDown(screen.getByRole("option", { name: ".." }), { key: "Backspace" });
    expect(await screen.findByText("/repo")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "conan" })),
    );
  });
});

describe("AddProjectDialog confirm", () => {
  it("adds the highlighted directory and closes when Enter is pressed in the browser", async () => {
    stubFetch();
    const { onAdd, onOpenChange } = renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));
    fireEvent.keyDown(conanRow, { key: "Enter" });

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("/repo/conan"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("confirms with Cmd+Enter", async () => {
    stubFetch();
    const { onAdd } = renderDialog();

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    const conanRow = await screen.findByRole("option", { name: "conan" });
    await waitFor(() => expect(document.activeElement).toBe(conanRow));
    fireEvent.keyDown(conanRow, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("/repo"));
  });

  it("shows an error and keeps the dialog open when onAdd fails", async () => {
    stubFetch();
    const onAdd = vi.fn().mockRejectedValue(new Error("add failed"));
    const onOpenChange = vi.fn();
    renderDialog({ onAdd, onOpenChange });

    fireEvent.click(
      await screen.findByRole("option", { name: "Local folder Browse a folder on disk" }),
    );
    await screen.findByText("/repo");

    fireEvent.keyDown(dialogContainer()!, { key: "Enter", metaKey: true });

    expect(
      await screen.findByText("Couldn't add that folder as a project. Try again."),
    ).toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledWith("/repo");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

});
