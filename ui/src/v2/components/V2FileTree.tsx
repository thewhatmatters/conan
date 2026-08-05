import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Text } from "@astryxdesign/core/Text";
import {
  ChevronRight,
  FileCode2,
  FileCog,
  FileImage,
  FileQuestion,
  Folder,
  FolderOpen,
} from "lucide-react";

export type FileStatus = "modified" | "added" | "deleted" | "untracked";

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  status?: FileStatus;
  children?: FileTreeNode[];
  parentId?: string;
}

interface VisibleNode extends FileTreeNode {
  depth: number;
}

const styles = stylex.create({
  tree: {
    minWidth: 0,
    width: "100%",
  },
  item: {
    minWidth: 0,
  },
  row: {
    alignItems: "center",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    border: 0,
    borderRadius: "var(--conan-radius-sm)",
    color: "var(--conan-text-primary)",
    cursor: "pointer",
    display: "flex",
    gap: "var(--conan-space-1)",
    minHeight: "var(--conan-control-height)",
    minWidth: 0,
    paddingBlock: "var(--conan-space-1)",
    paddingRight: "var(--conan-space-2)",
    textAlign: "left",
    width: "100%",
  },
  focusable: {
    outline: {
      default: "none",
      ":focus-visible": "var(--conan-border-width) solid var(--conan-color-border-strong)",
    },
    outlineOffset: "calc(-1 * var(--conan-border-width))",
  },
  chevron: {
    color: "var(--conan-icon-dim)",
    flexShrink: 0,
    transition: "transform var(--conan-duration-fast) var(--conan-ease)",
  },
  chevronOpen: { transform: "rotate(90deg)" },
  chevronSpacer: {
    flex: "0 0 var(--conan-space-4)",
  },
  icon: { color: "var(--conan-icon-muted)", flexShrink: 0 },
  codeIcon: { color: "var(--conan-color-warning)" },
  configIcon: { color: "var(--conan-text-muted)" },
  imageIcon: { color: "var(--conan-color-success)" },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trailing: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    gap: "var(--conan-space-1)",
    marginLeft: "auto",
  },
  status: {
    borderRadius: "var(--conan-radius-full)",
    flexShrink: 0,
    height: "var(--conan-space-2)",
    width: "var(--conan-space-2)",
  },
  modified: { backgroundColor: "var(--conan-color-warning)" },
  added: { backgroundColor: "var(--conan-color-success)" },
  untracked: { backgroundColor: "var(--conan-color-accent)" },
  deleted: { backgroundColor: "var(--conan-color-error)" },
  content: {
    minWidth: 0,
    paddingBottom: "var(--conan-space-3)",
    paddingLeft: "var(--conan-space-6)",
    paddingRight: "var(--conan-space-2)",
  },
});

const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);
const CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "toml"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "svg", "webp"]);

export type FileIconKind = "code" | "config" | "image" | "fallback";

export function rollupFileStatus(statuses: FileStatus[]): FileStatus | undefined {
  if (statuses.length === 0) return undefined;
  return statuses.every((status) => status === statuses[0]) ? statuses[0] : "modified";
}

export function fileIconKind(name: string): FileIconKind {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").pop() ?? "" : "";
  if (CONFIG_EXTENSIONS.has(extension) || lower.includes(".config.")) return "config";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "fallback";
}

export function buildFileTree<T extends { path: string; status: FileStatus }>(files: T[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let siblings = roots;
    let currentPath = "";
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      if (!name) continue;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isDir = index < parts.length - 1;
      let node = siblings.find((candidate) => candidate.name === name && candidate.isDir === isDir);
      if (!node) {
        node = {
          id: currentPath,
          name,
          path: currentPath,
          isDir,
          status: isDir ? undefined : file.status,
          children: isDir ? [] : undefined,
        };
        siblings.push(node);
      }
      siblings = node.children ?? [];
    }
  }
  const finish = (nodes: FileTreeNode[]): FileStatus[] => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    const statuses: FileStatus[] = [];
    for (const node of nodes) {
      const childStatuses = node.children ? finish(node.children) : [];
      if (node.isDir && childStatuses.length > 0) {
        node.status = rollupFileStatus(childStatuses);
      }
      if (node.status) statuses.push(node.status);
    }
    return statuses;
  };
  finish(roots);
  return roots;
}

export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const kind = fileIconKind(name);
  if (kind === "code") return <FileCode2 size={size} aria-hidden data-file-icon={kind} {...stylex.props(styles.icon, styles.codeIcon)} />;
  if (kind === "config") return <FileCog size={size} aria-hidden data-file-icon={kind} {...stylex.props(styles.icon, styles.configIcon)} />;
  if (kind === "image") return <FileImage size={size} aria-hidden data-file-icon={kind} {...stylex.props(styles.icon, styles.imageIcon)} />;
  return <FileQuestion size={size} aria-hidden data-file-icon={kind} {...stylex.props(styles.icon)} />;
}

function flattenVisible(
  nodes: FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId?: string,
): VisibleNode[] {
  const visible: VisibleNode[] = [];
  for (const node of nodes) {
    visible.push({ ...node, depth, parentId });
    if (node.isDir && expanded.has(node.id) && node.children) {
      visible.push(...flattenVisible(node.children, expanded, depth + 1, node.id));
    }
  }
  return visible;
}

export function V2FileTree({
  nodes,
  expanded,
  onToggle,
  onOpenFile,
  renderTrailing,
  renderExpandedFile,
  label,
}: {
  nodes: FileTreeNode[];
  expanded: ReadonlySet<string>;
  onToggle: (node: FileTreeNode) => void;
  onOpenFile: (node: FileTreeNode) => void;
  renderTrailing?: (node: FileTreeNode) => ReactNode;
  renderExpandedFile?: (node: FileTreeNode) => ReactNode;
  label: string;
}) {
  const visible = useMemo(() => flattenVisible(nodes, expanded), [expanded, nodes]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (visible.length === 0) setFocusedId(null);
    else if (!focusedId || !visible.some((node) => node.id === focusedId)) {
      setFocusedId(visible[0]?.id ?? null);
    }
  }, [focusedId, visible]);

  const focusNode = (node: VisibleNode | undefined) => {
    if (!node) return;
    setFocusedId(node.id);
    refs.current.get(node.id)?.focus();
  };

  return (
    <div role="tree" aria-label={label} {...stylex.props(styles.tree)}>
      {visible.map((node, index) => {
        const isExpanded = expanded.has(node.id);
        const expandable = node.isDir || renderExpandedFile != null;
        return (
          <div
            key={node.id}
            role="none"
            data-slot="file-tree-item"
            data-depth={node.depth}
            data-status={node.status}
            {...stylex.props(styles.item)}
          >
            <button
              ref={(element) => {
                if (element) refs.current.set(node.id, element);
                else refs.current.delete(node.id);
              }}
              type="button"
              role="treeitem"
              aria-level={node.depth + 1}
              aria-expanded={expandable ? isExpanded : undefined}
              aria-label={`${node.name}${node.status ? `, ${node.status}` : ""}`}
              tabIndex={focusedId === node.id ? 0 : -1}
              title={node.path}
              onFocus={() => setFocusedId(node.id)}
              onClick={() => (expandable ? onToggle(node) : onOpenFile(node))}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusNode(visible[index + 1]);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusNode(visible[index - 1]);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  focusNode(visible[0]);
                } else if (event.key === "End") {
                  event.preventDefault();
                  focusNode(visible[visible.length - 1]);
                } else if (event.key === "ArrowRight" && expandable) {
                  event.preventDefault();
                  if (!isExpanded) onToggle(node);
                  else focusNode(visible[index + 1]);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  if (expandable && isExpanded) onToggle(node);
                  else focusNode(visible.find((candidate) => candidate.id === node.parentId));
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (expandable) onToggle(node);
                  else onOpenFile(node);
                }
              }}
              {...stylex.props(styles.row, styles.focusable)}
              style={{ paddingLeft: `calc(var(--conan-space-2) + ${node.depth} * var(--conan-space-4))` }}
            >
              {expandable ? (
                <ChevronRight
                  size={16}
                  aria-hidden
                  {...stylex.props(styles.chevron, isExpanded && styles.chevronOpen)}
                />
              ) : (
                <span aria-hidden {...stylex.props(styles.chevronSpacer)} />
              )}
              {node.isDir ? (
                isExpanded ? (
                  <FolderOpen size={16} aria-hidden {...stylex.props(styles.icon)} />
                ) : (
                  <Folder size={16} aria-hidden {...stylex.props(styles.icon)} />
                )
              ) : (
                <FileTypeIcon name={node.name} />
              )}
              <span {...stylex.props(styles.name)}>
                <Text type="supporting">{node.name}</Text>
              </span>
              {node.status ? (
                <span
                  title={node.status}
                  aria-hidden
                  {...stylex.props(styles.status, styles[node.status])}
                />
              ) : null}
              {renderTrailing ? (
                <span {...stylex.props(styles.trailing)}>{renderTrailing(node)}</span>
              ) : null}
            </button>
            {!node.isDir && isExpanded && renderExpandedFile ? (
              <div {...stylex.props(styles.content)}>{renderExpandedFile(node)}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
