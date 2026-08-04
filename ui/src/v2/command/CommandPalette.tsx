/**
 * Command palette (WHA-70 shell · WHA-71 search source · WHA-72 actions).
 *
 * Paper artboard 1T4-0 — Actions over Recent Threads, a project search view,
 * footer keyboard hints.
 * https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/1T4-0
 *
 * WHA-70 shipped the shell with placeholder rows. This file replaces those with
 * the real thing: the shell (App.v2) owns the data and the handlers, and this
 * component owns the palette's own contents and its one piece of internal
 * navigation.
 *
 * HOW THE ARTBOARD MAPS ONTO ASTRYX
 * ---------------------------------
 *   - section headers    → `CommandPalette` auto-groups by `auxiliaryData.group`
 *   - icon/description/  → the `renderItem(item, isSelected)` slot, built from
 *     trailing time/chip     Astryx's `Item` (the same primitive the breadcrumb
 *                            switcher's rows use)
 *   - placeholder        → the `input` slot
 *   - rows before typing → `SearchSource.bootstrap()`
 *
 * THE ONE NON-OBVIOUS BIT — "New thread in…"
 * ------------------------------------------
 * Astryx hardwires close-on-select: `useCombobox`'s `onSelect` calls
 * `onValueChange` and THEN `handleClose()`. "New thread in…" has to keep the
 * palette open and swap its list to the projects, so the close that follows
 * that one row's selection is swallowed (`skipCloseRef`). Selection order is
 * what makes this safe — the value lands before the close, so the flag is
 * always set by the time the close arrives.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteInput,
  useCommandPaletteContext,
} from "@astryxdesign/core/CommandPalette";
import { useHotkeys } from "@astryxdesign/core/hooks";
import { Item } from "@astryxdesign/core/Item";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Text } from "@astryxdesign/core/Text";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  Settings,
  SquareDashed,
} from "lucide-react";
import { formatRelativeTime } from "../lib/relativeTime.ts";

/** A project the palette can start a thread in, or jump to. */
export interface PaletteProject {
  id: string;
  name: string;
  /** Absolute path — 1T4-0 prints it beside the name on the projects screen. */
  path?: string;
}

/** A recent thread row. `preview` is the sidebar's subtitle. */
export interface PaletteThread {
  id: string;
  title: string;
  preview: string;
  /** Epoch ms — rendered as `2d ago`. Absent for drafts. */
  lastActivity?: number;
}

export interface V2CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Every project, for "New thread in…" and project search. */
  projects?: PaletteProject[];
  /** Recent threads, already in the sidebar's order (newest activity first). */
  threads?: PaletteThread[];
  /** The open thread's project — the target of "New thread in <project>". */
  activeProject?: PaletteProject | null;
  onNewThreadIn?: (projectId: string) => void;
  onAddProject?: () => void;
  onOpenSettings?: () => void;
  onSelectThread?: (threadId: string) => void;
}

/** Stable ids for the action rows — also the `onValueChange` discriminator. */
const ACTION_NEW_THREAD_HERE = "action:new-thread-here";
const ACTION_NEW_THREAD_IN = "action:new-thread-in";
const ACTION_ADD_PROJECT = "action:add-project";
const ACTION_OPEN_SETTINGS = "action:open-settings";
const THREAD_PREFIX = "thread:";
const PROJECT_PREFIX = "project:";

const GROUP_ACTIONS = "Actions";
const GROUP_THREADS = "Recent Threads";
const GROUP_PROJECTS = "Projects";

/** 1T4-0 lists a handful, not the whole history — the sidebar is the full list. */
const MAX_RECENT_THREADS = 6;
/** Only the first nine project rows can carry a ⌘N chip; the digits run out. */
const MAX_PROJECT_SHORTCUTS = 9;

interface PaletteAux {
  group: string;
  icon: "new-thread" | "add-project" | "settings" | "thread" | "project";
  /**
   * The grey half of a row. 1T4-0 keeps rows to ONE line — a thread's preview
   * and a project's path sit INLINE after the title, not on a second line, and
   * that single-vs-double height is most of what makes the panel read right.
   */
  meta?: string;
  /** Trailing chip, e.g. `mod+n` — rendered through Astryx `Kbd`. */
  shortcut?: string;
  /** Trailing relative time, e.g. `2d ago`. */
  lastActivity?: number;
  /** Trailing chevron — the row opens another screen rather than acting. */
  hasSubmenu?: boolean;
}

type PaletteItem = SearchableItem<PaletteAux>;

// 1T4-0 gives BOTH "New thread" rows the same dashed-square glyph — they are
// the same verb, and only the trailing affordance (⌘N vs a chevron) separates
// them. `SquareDashed` is the closest Lucide match; flagged to Randy for a
// correction if he named a different one.
const ICONS = {
  "new-thread": SquareDashed,
  "add-project": FolderPlus,
  settings: Settings,
  thread: MessageSquare,
  project: Folder,
} as const;

const styles = stylex.create({
  row: {
    color: "var(--conan-text-primary)",
    width: "100%",
  },
  icon: {
    color: "var(--conan-icon-muted)",
    display: "flex",
    flexShrink: 0,
  },
  // The trailing lane: relative time or a chevron.
  trailing: {
    color: "var(--conan-text-muted)",
    display: "flex",
    flexShrink: 0,
    fontSize: "var(--conan-text-small)",
    whiteSpace: "nowrap",
  },
  // ONE LINE, two tones (1T4-0). The title keeps its intrinsic width and the
  // grey half takes the rest and truncates, so a long preview or a long path
  // can never push the trailing time out of the row.
  label: {
    alignItems: "baseline",
    display: "flex",
    gap: "var(--conan-space-2)",
    minWidth: 0,
  },
  labelTitle: {
    flexShrink: 0,
  },
  labelMeta: {
    color: "var(--conan-text-muted)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The projects screen's search row. Astryx's own input hard-codes a leading
  // magnifier with no slot to replace it, and 1T4-0 puts a BACK ARROW there —
  // it is the affordance that says "this is a second screen". So that one row
  // is rebuilt on the public palette context rather than faked around.
  searchRow: {
    alignItems: "center",
    borderBlockEndColor: "var(--conan-color-border)",
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: "var(--conan-border-width)",
    display: "flex",
    gap: "var(--conan-space-3)",
    paddingBlock: "var(--conan-space-3)",
    paddingInline: "var(--conan-space-4)",
  },
  backButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderRadius: "var(--conan-radius-sm)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    padding: 0,
  },
  searchInput: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: "var(--conan-text-primary)",
    flexGrow: 1,
    fontFamily: "var(--conan-font-sans)",
    fontSize: "var(--conan-text-body)",
    minWidth: 0,
    outline: "none",
    "::placeholder": { color: "var(--conan-text-muted)" },
  },
});

/**
 * The projects screen's search row: back arrow + input, wired to the palette
 * through `useCommandPaletteContext` (public API) so it keeps the same combobox
 * keyboard path as Astryx's own input — same role, same aria-controls,
 * same aria-activedescendant, same key handler.
 */
function ProjectsSearchInput({ onBack }: { onBack: () => void }) {
  const ctx = useCommandPaletteContext();
  return (
    <div {...stylex.props(styles.searchRow)} data-slot="palette-projects-search">
      <button
        type="button"
        aria-label="Back to commands"
        onClick={onBack}
        {...stylex.props(styles.backButton)}
      >
        <ArrowLeft size={16} aria-hidden />
      </button>
      <input
        type="text"
        role="combobox"
        aria-expanded={ctx?.isOpen ?? true}
        aria-autocomplete="list"
        aria-controls={ctx?.listId}
        aria-activedescendant={
          ctx && ctx.highlightedIndex >= 0
            ? ctx.getItemId(ctx.highlightedIndex)
            : undefined
        }
        aria-label="Search projects"
        placeholder="Search…"
        value={ctx?.search ?? ""}
        data-autofocus
        onChange={(event) => ctx?.setSearch(event.target.value)}
        onKeyDown={(event) => ctx?.onKeyDown(event)}
        {...stylex.props(styles.searchInput)}
      />
    </div>
  );
}

/** Case-insensitive substring match over the label and its description. */
function matches(item: PaletteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.auxiliaryData?.meta ?? ""}`;
  return haystack.toLowerCase().includes(needle);
}

export default function V2CommandPalette({
  isOpen,
  onOpenChange,
  projects = [],
  threads = [],
  activeProject = null,
  onNewThreadIn,
  onAddProject,
  onOpenSettings,
  onSelectThread,
}: V2CommandPaletteProps) {
  // "root" is the artboard's default view; "projects" is the secondary screen
  // behind "New thread in…" (Randy, 2026-08-04).
  const [view, setView] = useState<"root" | "projects">("root");
  const skipCloseRef = useRef(false);

  const rootItems = useMemo((): PaletteItem[] => {
    const actions: PaletteItem[] = [];
    if (activeProject && onNewThreadIn) {
      actions.push({
        id: ACTION_NEW_THREAD_HERE,
        label: `New thread in ${activeProject.name}`,
        auxiliaryData: { group: GROUP_ACTIONS, icon: "new-thread", shortcut: "mod+n" },
      });
    }
    if (projects.length > 0 && onNewThreadIn) {
      actions.push({
        id: ACTION_NEW_THREAD_IN,
        label: "New thread in…",
        // 1T4-0: a chevron, not a subtitle — the row goes somewhere.
        auxiliaryData: { group: GROUP_ACTIONS, icon: "new-thread", hasSubmenu: true },
      });
    }
    if (onAddProject) {
      actions.push({
        id: ACTION_ADD_PROJECT,
        label: "Add project",
        auxiliaryData: { group: GROUP_ACTIONS, icon: "add-project" },
      });
    }
    if (onOpenSettings) {
      actions.push({
        id: ACTION_OPEN_SETTINGS,
        label: "Open settings",
        auxiliaryData: { group: GROUP_ACTIONS, icon: "settings" },
      });
    }

    const recent: PaletteItem[] = threads
      .slice(0, MAX_RECENT_THREADS)
      .map((thread) => ({
        id: `${THREAD_PREFIX}${thread.id}`,
        label: thread.title,
        auxiliaryData: {
          group: GROUP_THREADS,
          icon: "thread",
          meta: thread.preview,
          lastActivity: thread.lastActivity,
        },
      }));

    return [...actions, ...recent];
  }, [activeProject, onAddProject, onNewThreadIn, onOpenSettings, projects.length, threads]);

  const projectItems = useMemo(
    (): PaletteItem[] =>
      projects.map((project, index) => ({
        id: `${PROJECT_PREFIX}${project.id}`,
        label: project.name,
        auxiliaryData: {
          group: GROUP_PROJECTS,
          icon: "project",
          meta: project.path,
          shortcut: index < MAX_PROJECT_SHORTCUTS ? `mod+${index + 1}` : undefined,
        },
      })),
    [projects],
  );

  // The source is swapped, not the dialog: Astryx re-reads `searchSource`, so
  // the secondary screen costs one state flag rather than a second palette.
  const searchSource = useMemo((): SearchSource<PaletteItem> => {
    const items = view === "projects" ? projectItems : rootItems;
    return {
      bootstrap: () => items,
      search: (query: string) => items.filter((item) => matches(item, query)),
    };
  }, [projectItems, rootItems, view]);

  // THE CHIPS ARE NOW REAL. They were painted from the artboard and bound to
  // nothing until Randy pressed one (2026-08-04) — a chip that advertises a
  // shortcut nobody registered is a lie in the UI, and this is the second time
  // this palette has shipped one (WHA-70's footer promised "↵ Select" with
  // nothing selectable).
  //
  // ⌘N and ⌘1…⌘9 are the artboard's bindings and they are correct for the
  // PRODUCT — Conan ships as a Tauri window with no browser tabs. A browser
  // preview will never show them working: Chrome/Arc/Safari claim ⌘1…⌘9 for tab
  // switching and ⌘N for a new window before the page sees the event. Scoped to
  // the palette being open, and to the screen the chip is drawn on.
  useHotkeys([
    {
      keys: "mod+n",
      allowInInputs: true,
      isDisabled: !isOpen || view !== "root" || !activeProject || !onNewThreadIn,
      onPress: () => {
        if (activeProject) onNewThreadIn?.(activeProject.id);
        onOpenChange(false);
      },
    },
    ...projects.slice(0, MAX_PROJECT_SHORTCUTS).map((project, index) => ({
      keys: `mod+${index + 1}`,
      allowInInputs: true,
      isDisabled: !isOpen || view !== "projects" || !onNewThreadIn,
      onPress: () => {
        onNewThreadIn?.(project.id);
        onOpenChange(false);
      },
    })),
  ]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Swallow exactly one close: the one Astryx fires after "New thread in…"
      // is selected, which must navigate rather than dismiss.
      if (!next && skipCloseRef.current) {
        skipCloseRef.current = false;
        return;
      }
      if (!next) setView("root");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleValueChange = useCallback(
    (value: string) => {
      if (value === ACTION_NEW_THREAD_IN) {
        skipCloseRef.current = true;
        setView("projects");
        return;
      }
      if (value === ACTION_NEW_THREAD_HERE) {
        if (activeProject) onNewThreadIn?.(activeProject.id);
        return;
      }
      if (value === ACTION_ADD_PROJECT) {
        onAddProject?.();
        return;
      }
      if (value === ACTION_OPEN_SETTINGS) {
        onOpenSettings?.();
        return;
      }
      if (value.startsWith(THREAD_PREFIX)) {
        onSelectThread?.(value.slice(THREAD_PREFIX.length));
        return;
      }
      if (value.startsWith(PROJECT_PREFIX)) {
        onNewThreadIn?.(value.slice(PROJECT_PREFIX.length));
      }
    },
    [activeProject, onAddProject, onNewThreadIn, onOpenSettings, onSelectThread],
  );

  const renderItem = useCallback((item: PaletteItem, isSelected: boolean) => {
    const aux = item.auxiliaryData;
    const Icon = ICONS[aux?.icon ?? "thread"];
    const time =
      typeof aux?.lastActivity === "number" ? formatRelativeTime(aux.lastActivity) : "";
    return (
      <Item
        // ONE line: title, then the grey half inline (1T4-0). Passing this as a
        // node rather than using `description` is the whole difference between
        // the artboard's compact rows and double-height ones.
        label={
          <span {...stylex.props(styles.label)}>
            <span {...stylex.props(styles.labelTitle)}>{item.label}</span>
            {aux?.meta ? (
              <span {...stylex.props(styles.labelMeta)}>{aux.meta}</span>
            ) : null}
          </span>
        }
        isSelected={isSelected}
        startContent={
          <Text color="inherit" xstyle={styles.icon} aria-hidden>
            <Icon size={16} />
          </Text>
        }
        endContent={
          aux?.shortcut ? (
            <Kbd keys={aux.shortcut} />
          ) : aux?.hasSubmenu ? (
            <Text color="inherit" xstyle={styles.trailing} aria-hidden>
              <ChevronRight size={16} />
            </Text>
          ) : time ? (
            <Text color="inherit" xstyle={styles.trailing}>
              {time}
            </Text>
          ) : undefined
        }
        xstyle={styles.row}
      />
    );
  }, []);

  return (
    <AstryxCommandPalette
      // Keyed on the view because Astryx bootstraps its list on OPEN, not when
      // `searchSource` changes — and the select that navigates here has already
      // run its internal close, which clears the results. Remounting is what
      // makes the projects screen actually populate; without it you land on an
      // empty list. (The close itself is swallowed above, so nothing dismisses.)
      key={view}
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      onValueChange={handleValueChange}
      searchSource={searchSource}
      renderItem={renderItem}
      width={640}
      label={view === "projects" ? "Choose a project" : "Command palette"}
      input={
        view === "projects" ? (
          <ProjectsSearchInput onBack={() => setView("root")} />
        ) : (
          <CommandPaletteInput
            placeholder="Search commands, projects and threads…"
            label="Search commands, projects and threads"
          />
        )
      }
      emptyBootstrapText={
        view === "projects" ? "No projects yet" : "Type to search"
      }
      data-slot="command-palette"
      data-palette-view={view}
    />
  );
}
