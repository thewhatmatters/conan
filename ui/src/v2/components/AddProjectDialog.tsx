/**
 * AddProjectDialog — v2 folder browser (WHA-201).
 *
 * Paper artboard 7GE-0 "Folder/file browser" plus the 777-0 confirm affordance.
 * https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/7GE-0
 *
 * ENTRY POINT
 * -----------
 * Both the sidebar "Add project" control and the ⌘K "Add project" action set
 * `isAddingProject(true)`, so this is the single surface they share. The first
 * pane is a source picker (currently only "Local folder"), then the user drills
 * into the filesystem.
 *
 * KEYBOARD MODEL
 * --------------
 *   ↑ / ↓      move focus between rows
 *   ↵          activate the focused row (descend into a directory, go up for "..")
 *   Backspace  go to the parent directory
 *   Esc        close the dialog
 *   ⌘+Enter    add the currently-browsed folder as a project (777-0 confirm)
 *
 * The ⌘+Enter shortcut and the header "Add" pill are the *confirm* call site;
 * Enter on a row is the *descend* call site. Keeping them separate means the
 * keyboard model does not have to be rewritten if 777-0 (explicit Add) turns out
 * to be the current design.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowLeft, CornerLeftUp, Folder, FolderPlus } from "lucide-react";
import { apiBase } from "../../lib/gateway.ts";
import { openFolder } from "../lib/openFolder.ts";

/** Structural copy of the gateway's /api/fs/list payload (the dirs half). */
interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

export interface AddProjectDialogProps {
  isOpen: boolean;
  token: string | null;
  /** Where browsing starts — the gateway's own cwd. */
  start: string;
  onOpenChange: (isOpen: boolean) => void;
  /** Resolves once the project row exists; the shell then refreshes. */
  onAdd: (path: string) => Promise<void>;
}

type View = { type: "source" } | { type: "browser"; listing: FsListing };

type RowItem =
  | { kind: "source"; id: string; name: string; path: string; meta: string }
  | { kind: "up"; id: string; name: string; path: string }
  | { kind: "dir"; id: string; name: string; path: string };

const ICON = 16;
const SOURCE_LOCAL = "source:local";

const styles = stylex.create({
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  header: {
    alignItems: "center",
    borderBottomColor: "var(--conan-color-border)",
    borderBottomStyle: "solid",
    borderBottomWidth: "var(--conan-border-width)",
    display: "flex",
    flexShrink: 0,
    gap: "var(--conan-space-3)",
    paddingBlock: "var(--conan-space-3)",
    paddingInline: "var(--conan-space-4)",
  },
  headerButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-sm)",
    borderStyle: "none",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    padding: "var(--conan-space-1)",
    ":hover": {
      backgroundColor: "var(--conan-wash-hover)",
    },
    ":focus-visible": {
      backgroundColor: "var(--conan-wash-hover)",
    },
  },
  headerButtonDisabled: {
    cursor: "not-allowed",
    opacity: 0.5,
  },
  path: {
    color: "var(--conan-text-primary)",
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  list: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    padding: "var(--conan-space-1)",
  },
  sectionHeader: {
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-3)",
  },
  row: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "none",
    color: "var(--conan-text-primary)",
    cursor: "pointer",
    display: "flex",
    gap: "var(--conan-space-2)",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-3)",
    textAlign: "start",
    width: "100%",
    ":hover": {
      backgroundColor: "var(--conan-wash-hover)",
    },
    ":focus-visible": {
      backgroundColor: "var(--conan-wash-hover)",
    },
  },
  rowSelected: {
    backgroundColor: "var(--conan-wash-row-selected)",
    ":hover": {
      backgroundColor: "var(--conan-wash-row-selected)",
    },
    ":focus-visible": {
      backgroundColor: "var(--conan-wash-row-selected)",
    },
  },
  rowDisabled: {
    cursor: "not-allowed",
    opacity: 0.5,
  },
  meta: {
    color: "var(--conan-text-muted)",
  },
  footer: {
    alignItems: "center",
    borderTopColor: "var(--conan-color-border)",
    borderTopStyle: "solid",
    borderTopWidth: "var(--conan-border-width)",
    display: "flex",
    flexShrink: 0,
    gap: "var(--conan-space-4)",
    justifyContent: "space-between",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-4)",
  },
  footerGroup: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    gap: "var(--conan-space-1)",
  },
  footerShortcuts: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--conan-space-4)",
    minWidth: 0,
  },
  link: {
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    color: "var(--conan-text-muted)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "inherit",
    padding: 0,
    ":hover": {
      color: "var(--conan-text-primary)",
    },
  },
  error: {
    color: "var(--conan-color-error)",
    paddingInline: "var(--conan-space-3)",
  },
});

export default function AddProjectDialog({
  isOpen,
  token,
  start,
  onOpenChange,
  onAdd,
}: AddProjectDialogProps) {
  const [view, setView] = useState<View>({ type: "source" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const listId = useId();
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items = useMemo((): RowItem[] => {
    if (view.type === "source") {
      return [
        {
          kind: "source",
          id: SOURCE_LOCAL,
          name: "Local folder",
          path: start,
          meta: "Browse a folder on disk",
        },
      ];
    }
    const listing = view.listing;
    const rows: RowItem[] = [];
    if (listing.parent) {
      rows.push({ kind: "up", id: "up", name: "..", path: listing.parent });
    }
    for (const entry of listing.entries) {
      if (!entry.isDir) continue;
      rows.push({ kind: "dir", id: entry.path, name: entry.name, path: entry.path });
    }
    return rows;
  }, [view, start]);

  // Reset selection whenever the available rows change.
  useEffect(() => {
    setSelectedIndex(0);
    rowRefs.current = items.map(() => null);
  }, [items]);

  // Move focus to the selected row so keyboard navigation stays visible.
  useEffect(() => {
    rowRefs.current[selectedIndex]?.focus();
  }, [selectedIndex]);

  const browse = useCallback(
    async (target: string) => {
      if (!token) return;
      setError(null);
      try {
        const response = await fetch(
          apiBase() + `/api/fs/list?path=${encodeURIComponent(target)}`,
          { headers: { "x-conan-token": token } },
        );
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as FsListing;
        setView({ type: "browser", listing: data });
        setError(data.error ?? null);
      } catch {
        setError("Couldn't read that folder.");
      }
    },
    [token],
  );

  useEffect(() => {
    if (!isOpen) return;
    setView({ type: "source" });
    setError(null);
    setBusy(false);
  }, [isOpen]);

  const close = useCallback(() => {
    if (!busy) onOpenChange(false);
  }, [busy, onOpenChange]);

  const confirm = useCallback(async () => {
    if (busy || view.type !== "browser") return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(view.listing.path);
      onOpenChange(false);
    } catch {
      setError("Couldn't add that folder as a project. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, onAdd, onOpenChange, view]);

  const activate = useCallback(
    (item: RowItem) => {
      if (busy) return;
      if (item.kind === "source") {
        void browse(item.path);
        return;
      }
      void browse(item.path);
    },
    [browse, busy],
  );

  const goBack = useCallback(() => {
    if (busy) return;
    if (view.type === "source") {
      close();
      return;
    }
    if (view.listing.parent) {
      void browse(view.listing.parent);
    } else {
      close();
    }
  }, [busy, close, view, browse]);

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((prev) =>
        Math.max(0, Math.min(items.length - 1, prev + delta)),
      );
    },
    [items.length],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        goBack();
        return;
      }
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        void confirm();
      }
    },
    [confirm, goBack, moveSelection],
  );

  const handleOpenFinder = useCallback(async () => {
    if (view.type !== "browser") return;
    try {
      await openFolder(view.listing.path);
    } catch {
      // Best-effort: opening the local folder is allowed to fail silently in
      // sandboxed/browser contexts.
    }
  }, [view]);

  const headerLabel =
    view.type === "source" ? "Search" : view.listing.path;

  const headerBackLabel =
    view.type === "source"
      ? "Close"
      : view.type === "browser" && view.listing.parent
        ? "Go to parent folder"
        : "Close";

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={640}
      maxHeight={480}
      padding={0}
      aria-label="Add project"
    >
      <div
        {...stylex.props(styles.container)}
        onKeyDown={handleKeyDown}
        data-slot="add-project-dialog"
      >
        <div {...stylex.props(styles.header)}>
          <button
            type="button"
            aria-label={headerBackLabel}
            onClick={goBack}
            disabled={busy}
            {...stylex.props(styles.headerButton, busy && styles.headerButtonDisabled)}
          >
            <ArrowLeft size={ICON} aria-hidden />
          </button>
          <Text
            type="body"
            color={view.type === "source" ? "secondary" : "primary"}
            xstyle={styles.path}
          >
            {headerLabel}
          </Text>
          {view.type === "browser" && (
            <HStack align="center" gap={2}>
              <Button
                label="Add"
                variant="primary"
                size="sm"
                onClick={() => void confirm()}
                isDisabled={busy}
                isLoading={busy}
              />
              <Kbd keys="mod+enter" />
            </HStack>
          )}
        </div>

        <div
          {...stylex.props(styles.list)}
          role="listbox"
          aria-label={view.type === "source" ? "Sources" : "Directories"}
          aria-activedescendant={
            items[selectedIndex] ? `${listId}-${items[selectedIndex].id}` : undefined
          }
        >
          <VStack gap={0.5}>
            {view.type === "browser" && (
              <div {...stylex.props(styles.sectionHeader)}>
                <Text type="supporting" color="secondary">
                  Directories
                </Text>
              </div>
            )}
            {view.type === "source" && (
              <div {...stylex.props(styles.sectionHeader)}>
                <Text type="supporting" color="secondary">
                  Sources
                </Text>
              </div>
            )}

            {items.length === 0 ? (
              <div {...stylex.props(styles.sectionHeader)}>
                <Text type="supporting" color="secondary">
                  No folders here.
                </Text>
              </div>
            ) : (
              items.map((item, index) => {
                const selected = index === selectedIndex;
                const Icon =
                  item.kind === "source"
                    ? FolderPlus
                    : item.kind === "up"
                      ? CornerLeftUp
                      : Folder;
                return (
                  <button
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    aria-label={
                      item.kind === "source"
                        ? `${item.name} ${item.meta}`
                        : item.name
                    }
                    data-autofocus={index === 0}
                    disabled={busy}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => activate(item)}
                    {...stylex.props(
                      styles.row,
                      selected && styles.rowSelected,
                      busy && styles.rowDisabled,
                    )}
                  >
                    <Icon size={ICON} aria-hidden />
                    {item.kind === "source" ? (
                      <HStack align="center" gap={2}>
                        <Text color="primary">{item.name}</Text>
                        <Text type="supporting" color="secondary" xstyle={styles.meta}>
                          {item.meta}
                        </Text>
                      </HStack>
                    ) : (
                      <Text color="primary">{item.name}</Text>
                    )}
                  </button>
                );
              })
            )}
          </VStack>

          {error ? (
            <Text type="supporting" color="inherit" xstyle={styles.error}>
              {error}
            </Text>
          ) : null}
        </div>

        <div {...stylex.props(styles.footer)}>
          <HStack gap={4} xstyle={styles.footerShortcuts}>
            <span {...stylex.props(styles.footerGroup)}>
              <Kbd keys="up" />
              <Kbd keys="down" />
              <Text type="supporting" color="secondary">
                Navigate
              </Text>
            </span>
            <span {...stylex.props(styles.footerGroup)}>
              <Kbd keys="enter" />
              <Text type="supporting" color="secondary">
                Select
              </Text>
            </span>
            <span {...stylex.props(styles.footerGroup)}>
              <Kbd keys="escape" />
              <Text type="supporting" color="secondary">
                Close
              </Text>
            </span>
            <span {...stylex.props(styles.footerGroup)}>
              <Kbd keys="backspace" />
              <Text type="supporting" color="secondary">
                Back
              </Text>
            </span>
          </HStack>
          <button
            type="button"
            onClick={() => void handleOpenFinder()}
            disabled={busy || view.type !== "browser"}
            {...stylex.props(
              styles.link,
              (busy || view.type !== "browser") && styles.rowDisabled,
            )}
          >
            <Text type="supporting" color="inherit">
              Open in Finder
            </Text>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
