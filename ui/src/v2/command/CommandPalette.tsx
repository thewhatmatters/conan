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
import { CommandPalette as AstryxCommandPalette } from "@astryxdesign/core/CommandPalette";
import { CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import { Item } from "@astryxdesign/core/Item";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Text } from "@astryxdesign/core/Text";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import {
  FolderOpen,
  FolderPlus,
  MessageSquare,
  MessageSquarePlus,
  Settings,
} from "lucide-react";
import { formatRelativeTime } from "../lib/relativeTime.ts";

/** A project the palette can start a thread in, or jump to. */
export interface PaletteProject {
  id: string;
  name: string;
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
  icon: "new-thread" | "new-thread-in" | "add-project" | "settings" | "thread" | "project";
  description?: string;
  /** Trailing chip, e.g. `mod+n` — rendered through Astryx `Kbd`. */
  shortcut?: string;
  /** Trailing relative time, e.g. `2d ago`. */
  lastActivity?: number;
}

type PaletteItem = SearchableItem<PaletteAux>;

const ICONS = {
  "new-thread": MessageSquarePlus,
  "new-thread-in": FolderOpen,
  "add-project": FolderPlus,
  settings: Settings,
  thread: MessageSquare,
  project: FolderOpen,
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
  meta: {
    color: "var(--conan-text-muted)",
    flexShrink: 0,
    fontSize: "var(--conan-text-small)",
    whiteSpace: "nowrap",
  },
});

/** Case-insensitive substring match over the label and its description. */
function matches(item: PaletteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.auxiliaryData?.description ?? ""}`;
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
        auxiliaryData: {
          group: GROUP_ACTIONS,
          icon: "new-thread-in",
          description: "Choose a project",
        },
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
          description: thread.preview,
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
        label={item.label}
        description={aux?.description}
        labelLines={1}
        descriptionLines={1}
        isSelected={isSelected}
        startContent={
          <Text color="inherit" xstyle={styles.icon} aria-hidden>
            <Icon size={16} />
          </Text>
        }
        endContent={
          aux?.shortcut ? (
            <Kbd keys={aux.shortcut} />
          ) : time ? (
            <Text color="inherit" xstyle={styles.meta}>
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
        <CommandPaletteInput
          placeholder={
            view === "projects"
              ? "Search projects…"
              : "Search commands, projects and threads…"
          }
          label={
            view === "projects"
              ? "Search projects"
              : "Search commands, projects and threads"
          }
        />
      }
      emptyBootstrapText={
        view === "projects" ? "No projects yet" : "Type to search"
      }
      data-slot="command-palette"
      data-palette-view={view}
    />
  );
}
