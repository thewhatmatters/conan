import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildFileTree,
  fileIconKind,
  V2FileTree,
  type FileTreeNode,
} from "../components/V2FileTree.tsx";
import { V2DiffSurface, V2FilesSurface } from "../components/V2SurfaceBodies.tsx";

describe("v2 file presentation", () => {
  it.each([
    ["App.tsx", "code"],
    ["worker.js", "code"],
    ["settings.json", "config"],
    ["vite.config.ts", "config"],
    ["artwork.webp", "image"],
    ["README", "fallback"],
  ] as const)("maps %s to the %s icon", (name, expected) => {
    expect(fileIconKind(name)).toBe(expected);
  });

  it("groups paths into folders and carries change status up the tree", () => {
    const tree = buildFileTree([
      { path: "src/App.tsx", status: "added" as const },
      { path: "src/lib/data.json", status: "added" as const },
      { path: "README.md", status: "deleted" as const },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0]).toMatchObject({ isDir: true, status: "added" });
    expect(tree[0]?.children?.map((node) => node.name)).toEqual(["lib", "App.tsx"]);
    expect(tree[1]).toMatchObject({ status: "deleted" });
  });
});

const nodes: FileTreeNode[] = [
  {
    id: "src",
    name: "src",
    path: "src",
    isDir: true,
    status: "modified",
    children: [
      {
        id: "src/App.tsx",
        name: "App.tsx",
        path: "src/App.tsx",
        isDir: false,
        status: "added",
      },
    ],
  },
  { id: "README.md", name: "README.md", path: "README.md", isDir: false },
];

function TreeHarness({ onOpenFile = vi.fn() }: { onOpenFile?: (node: FileTreeNode) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <V2FileTree
      label="Changed files"
      nodes={nodes}
      expanded={expanded}
      onToggle={(node) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      })}
      onOpenFile={onOpenFile}
    />
  );
}

describe("V2FileTree keyboard interaction", () => {
  it("hides children until a folder is expanded with Enter", () => {
    render(<TreeHarness />);
    const folder = screen.getByRole("treeitem", { name: "src, modified" });

    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "App.tsx, added" })).toBeNull();
    fireEvent.keyDown(folder, { key: "Enter" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "App.tsx, added" })).toBeInTheDocument();
  });

  it("uses roving focus with arrows and Space toggles folders", () => {
    render(<TreeHarness />);
    const folder = screen.getByRole("treeitem", { name: "src, modified" });
    folder.focus();
    fireEvent.keyDown(folder, { key: " " });
    fireEvent.keyDown(folder, { key: "ArrowDown" });

    expect(screen.getByRole("treeitem", { name: "App.tsx, added" })).toHaveFocus();
  });

  it("opens a focused file with Enter", () => {
    const onOpenFile = vi.fn();
    render(<TreeHarness onOpenFile={onOpenFile} />);
    const file = screen.getByRole("treeitem", { name: "README.md" });
    fireEvent.keyDown(file, { key: "Enter" });

    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "README.md" }));
  });
});

const response = (data: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);

describe("v2 Files and Diff surfaces", () => {
  it("lazy-loads folders and presents file icons and git status", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fs/diff")) {
        return response({
          repo: true,
          root: "/repo",
          files: [{ path: "src/App.tsx", status: "modified", patch: "", truncated: false }],
        });
      }
      const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
      return response(path === "/repo/src"
        ? { path, parent: "/repo", entries: [{ name: "App.tsx", path: "/repo/src/App.tsx", isDir: false, size: 1, mtimeMs: 1 }] }
        : { path: "/repo", parent: null, entries: [{ name: "src", path: "/repo/src", isDir: true, size: 0, mtimeMs: 1 }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<V2FilesSurface token="token" cwd="/repo" />);

    const folder = await screen.findByRole("treeitem", { name: "src, modified" });
    fireEvent.click(folder);
    const file = await screen.findByRole("treeitem", { name: "App.tsx, modified" });
    expect(file.querySelector('[data-file-icon="code"]')).toBeInTheDocument();
    expect(container.querySelector('[data-status="modified"]')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("/repo/src")),
      expect.anything(),
    );
  });

  it("shows a collapsible changed-file list with aligned addition and deletion counts", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({
      repo: true,
      root: "/repo",
      files: [{
        path: "src/App.tsx",
        status: "added",
        truncated: false,
        patch: "@@ -0,0 +1,2 @@\n+one\n+two",
      }],
    })));
    render(<V2DiffSurface token="token" cwd="/repo" />);

    const file = await screen.findByRole("treeitem", { name: "App.tsx, added" });
    expect(file).toHaveTextContent("+2/−0");
    expect(file.querySelector('[data-file-icon="code"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "src, added" }));
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: "App.tsx, added" })).toBeNull());
  });
});
