/**
 * Sidebar ordering (WHA-60, from Paper `73D-0`).
 *
 * Pure comparators over the domain rows, deliberately separate from the menu
 * that picks them and from the shell that renders the result. Ordering runs on
 * `/api/agent/projects` rows — NOT on the presentational `ThreadRowProps` the
 * tree receives — because only the domain rows carry `createdAt` and `provider`,
 * and re-deriving them into the view model just to sort would be a lie waiting
 * to drift.
 *
 * Every comparator is TOTAL: each one falls through to a stable tiebreak so two
 * rows never compare equal. `Array.prototype.sort` is stable in every engine we
 * ship to, but "stable" only preserves the *input* order, and the input here is
 * a fetch result that can come back in a different order after any refresh. A
 * partial comparator would let rows swap places on an unrelated poll.
 *
 * `73D-0` draws no grouping, no text filter, and no reset — see WHA-78. This
 * module orders; it does not filter.
 */

/** The `Order Projects By` options, in the artboard's row order. */
export const PROJECT_ORDERS = ["lastActivity", "name", "recentlyAdded"] as const;
export type ProjectOrder = (typeof PROJECT_ORDERS)[number];

/** The `Order Threads By` options, in the artboard's row order. */
export const THREAD_ORDERS = [
  "agent",
  "lastActivity",
  "name",
  "recentlyAdded",
] as const;
export type ThreadOrder = (typeof THREAD_ORDERS)[number];

/** Menu copy, verbatim from `73D-0`. */
export const PROJECT_ORDER_LABELS: Record<ProjectOrder, string> = {
  lastActivity: "Last Activity",
  name: "Name",
  recentlyAdded: "Recently Added",
};

export const THREAD_ORDER_LABELS: Record<ThreadOrder, string> = {
  agent: "Agent",
  lastActivity: "Last Activity",
  name: "Name",
  recentlyAdded: "Recently Added",
};

/**
 * Defaults deliberately match what ships today (`listChatProjects` returns
 * projects newest-activity-first and threads `ORDER BY last_activity DESC`), so
 * a user who never opens the menu sees the sidebar they already had.
 *
 * `73D-0` draws Recently Added checked for projects, which is NOT today's
 * behaviour. A mock showing a checkmark is not the same claim as a mock
 * specifying a default, and adopting it would silently reorder every existing
 * user's sidebar on upgrade — so it stays flagged on the ticket rather than
 * assumed here. Flipping it is this one constant.
 */
export const DEFAULT_PROJECT_ORDER: ProjectOrder = "lastActivity";
export const DEFAULT_THREAD_ORDER: ThreadOrder = "lastActivity";

export function isProjectOrder(value: unknown): value is ProjectOrder {
  return (PROJECT_ORDERS as readonly unknown[]).includes(value);
}

export function isThreadOrder(value: unknown): value is ThreadOrder {
  return (THREAD_ORDERS as readonly unknown[]).includes(value);
}

/** The fields ordering reads off a project. Structural, so callers pass their
 *  own richer row type and get it back unchanged. */
export interface OrderableProject {
  name: string;
  createdAt: number;
  threads?: readonly { lastActivity: number }[];
}

/** The fields ordering reads off a saved thread. */
export interface OrderableThread {
  title: string | null;
  provider: string | null;
  createdAt: number;
  lastActivity: number;
}

/** Case- and accent-insensitive, locale-aware name compare — "Ápp" sorts with
 *  "app", not after "Zebra", which is what a human reading a folder list
 *  expects. `sensitivity: "base"` is what makes it case-insensitive. */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** A project's activity is its most recent thread's, or its own creation time
 *  when it has none. Computed as a MAX rather than trusting `threads[0]`: the
 *  wire happens to arrive newest-first today, but ordering that depends on the
 *  server's sort silently breaks the moment that changes. */
export function projectActivity(project: OrderableProject): number {
  let latest = project.createdAt;
  for (const thread of project.threads ?? []) {
    if (thread.lastActivity > latest) latest = thread.lastActivity;
  }
  return latest;
}

/** Untitled threads sort together under one label rather than scattering by
 *  whatever placeholder the view model happens to use. */
function threadName(thread: OrderableThread): string {
  return thread.title ?? "";
}

export function orderProjects<T extends OrderableProject>(
  projects: readonly T[],
  order: ProjectOrder,
): T[] {
  const rows = [...projects];
  switch (order) {
    case "name":
      // Name is the tiebreak everywhere else, so it needs its own: two folders
      // can share a basename when they live in different parents.
      rows.sort(
        (a, b) =>
          collator.compare(a.name, b.name) || b.createdAt - a.createdAt,
      );
      break;
    case "recentlyAdded":
      rows.sort(
        (a, b) => b.createdAt - a.createdAt || collator.compare(a.name, b.name),
      );
      break;
    case "lastActivity":
      rows.sort(
        (a, b) =>
          projectActivity(b) - projectActivity(a) ||
          collator.compare(a.name, b.name),
      );
      break;
  }
  return rows;
}

export function orderThreads<T extends OrderableThread>(
  threads: readonly T[],
  order: ThreadOrder,
): T[] {
  const rows = [...threads];
  switch (order) {
    case "agent":
      // Group by provider, then most recent first inside each provider — the
      // list stays useful once you are inside a group. Null coalesces to
      // "claude" to match how the gateway reads pre-migration rows.
      rows.sort(
        (a, b) =>
          collator.compare(a.provider ?? "claude", b.provider ?? "claude") ||
          b.lastActivity - a.lastActivity ||
          collator.compare(threadName(a), threadName(b)),
      );
      break;
    case "name":
      rows.sort(
        (a, b) =>
          collator.compare(threadName(a), threadName(b)) ||
          b.lastActivity - a.lastActivity,
      );
      break;
    case "recentlyAdded":
      rows.sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          collator.compare(threadName(a), threadName(b)),
      );
      break;
    case "lastActivity":
      rows.sort(
        (a, b) =>
          b.lastActivity - a.lastActivity ||
          collator.compare(threadName(a), threadName(b)),
      );
      break;
  }
  return rows;
}
