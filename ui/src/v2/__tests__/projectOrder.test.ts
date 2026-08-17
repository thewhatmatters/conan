/**
 * projectOrder — the WHA-60 comparators (Paper `73D-0`).
 *
 * These are the assertions that matter here, as opposed to descriptions of the
 * code:
 *
 * - **Totality.** Every comparator falls through to a tiebreak, so equal
 *   primary keys still produce one fixed order. Without it the sidebar can
 *   reshuffle on an unrelated refresh; each order gets a tie case that fails if
 *   the fallthrough is deleted.
 * - **`projectActivity` is a MAX, not `threads[0]`.** The wire happens to
 *   arrive newest-first today. The out-of-order fixture below is the guard
 *   against someone "simplifying" it back to an index read.
 * - **Defaults are today's shipped behaviour**, not the artboard's checkmarks —
 *   see the note in the module. Pinned so flipping them is a deliberate act.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ORDER,
  DEFAULT_THREAD_ORDER,
  isProjectOrder,
  isThreadOrder,
  orderProjects,
  orderThreads,
  projectActivity,
  type OrderableProject,
  type OrderableThread,
} from "../lib/projectOrder.ts";

function project(
  name: string,
  createdAt: number,
  activity: number[] = [],
): OrderableProject & { name: string } {
  return {
    name,
    createdAt,
    threads: activity.map((lastActivity) => ({ lastActivity })),
  };
}

function thread(
  title: string | null,
  provider: string | null,
  createdAt: number,
  lastActivity: number,
): OrderableThread {
  return { title, provider, createdAt, lastActivity };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);
const titles = (rows: OrderableThread[]) => rows.map((r) => r.title);

describe("projectActivity", () => {
  it("takes the newest thread even when the list is not sorted", () => {
    // The guard against reading threads[0]: the newest sits in the middle.
    expect(projectActivity(project("a", 1, [10, 900, 50]))).toBe(900);
  });

  it("falls back to the project's own creation time with no threads", () => {
    expect(projectActivity(project("a", 42))).toBe(42);
  });

  it("prefers creation time when every thread predates it", () => {
    expect(projectActivity(project("a", 500, [10, 20]))).toBe(500);
  });
});

describe("orderProjects", () => {
  it("orders by newest activity, not by the row's own createdAt", () => {
    const rows = [
      project("stale-but-new", 900, [1]),
      project("old-but-busy", 1, [1000]),
    ];

    expect(names(orderProjects(rows, "lastActivity"))).toEqual([
      "old-but-busy",
      "stale-but-new",
    ]);
  });

  it("orders by name case-insensitively", () => {
    const rows = [project("zebra", 1), project("Apple", 2), project("mango", 3)];

    expect(names(orderProjects(rows, "name"))).toEqual([
      "Apple",
      "mango",
      "zebra",
    ]);
  });

  it("orders by newest createdAt for Recently Added", () => {
    const rows = [project("first", 1), project("third", 3), project("second", 2)];

    expect(names(orderProjects(rows, "recentlyAdded"))).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("breaks an activity tie by name rather than leaving it to input order", () => {
    const rows = [project("beta", 5, [100]), project("alpha", 9, [100])];

    expect(names(orderProjects(rows, "lastActivity"))).toEqual(["alpha", "beta"]);
  });

  it("breaks a createdAt tie by name", () => {
    const rows = [project("beta", 7), project("alpha", 7)];

    expect(names(orderProjects(rows, "recentlyAdded"))).toEqual(["alpha", "beta"]);
  });

  it("breaks a same-name tie by newest first, so two folders never swap", () => {
    const rows = [project("conan", 1), project("conan", 9)];

    expect(orderProjects(rows, "name").map((r) => r.createdAt)).toEqual([9, 1]);
  });

  it("treats names differing only in case as a tie, decided by the tiebreak", () => {
    // The discriminating case for `sensitivity: "base"`. A plain collator still
    // puts "Apple" before "zebra" — base letters dominate — so an A/m/z fixture
    // cannot tell the two configurations apart. Names differing ONLY by case
    // can: under "base" they compare equal and fall to the createdAt tiebreak
    // (newest first); without it, the locale's case rule decides instead.
    const rows = [project("conan", 1), project("Conan", 9)];

    expect(orderProjects(rows, "name").map((r) => r.createdAt)).toEqual([9, 1]);
  });

  it("does not mutate its input", () => {
    const rows = [project("b", 2), project("a", 1)];
    orderProjects(rows, "name");

    expect(names(rows)).toEqual(["b", "a"]);
  });
});

describe("orderThreads", () => {
  it("orders by most recent activity", () => {
    const rows = [
      thread("old", "claude", 1, 10),
      thread("new", "claude", 2, 90),
    ];

    expect(titles(orderThreads(rows, "lastActivity"))).toEqual(["new", "old"]);
  });

  it("groups by provider, newest first inside each group", () => {
    const rows = [
      thread("grok-old", "grok", 1, 10),
      thread("claude-old", "claude", 1, 20),
      thread("grok-new", "grok", 1, 99),
      thread("claude-new", "claude", 1, 50),
    ];

    expect(titles(orderThreads(rows, "agent"))).toEqual([
      "claude-new",
      "claude-old",
      "grok-new",
      "grok-old",
    ]);
  });

  it("reads a null provider as claude, matching the gateway", () => {
    // No real provider id sorts before "claude", so "does null lead?" cannot
    // tell null→"claude" from null→"". The discriminating question is whether
    // the legacy row INTERLEAVES with the claude rows by activity or forms its
    // own block ahead of them — which is what coalescing to "" would do.
    const rows = [
      thread("codex", "codex", 1, 99),
      thread("claude-new", "claude", 1, 90),
      thread("legacy", null, 1, 50),
      thread("claude-old", "claude", 1, 10),
    ];

    expect(titles(orderThreads(rows, "agent"))).toEqual([
      "claude-new",
      "legacy",
      "claude-old",
      "codex",
    ]);
  });

  it("orders by title case-insensitively, untitled rows together", () => {
    const rows = [
      thread("zeta", "claude", 1, 1),
      thread(null, "claude", 1, 5),
      thread("Alpha", "claude", 1, 1),
      thread(null, "claude", 1, 9),
    ];

    // Untitled ("") sorts first as a block, newest of the two leading.
    expect(titles(orderThreads(rows, "name"))).toEqual([
      null,
      null,
      "Alpha",
      "zeta",
    ]);
    expect(orderThreads(rows, "name")[0]?.lastActivity).toBe(9);
  });

  it("orders by newest createdAt for Recently Added", () => {
    const rows = [
      thread("a", "claude", 1, 99),
      thread("b", "claude", 9, 1),
    ];

    expect(titles(orderThreads(rows, "recentlyAdded"))).toEqual(["b", "a"]);
  });

  it("breaks an activity tie by title", () => {
    const rows = [
      thread("beta", "claude", 1, 100),
      thread("alpha", "claude", 2, 100),
    ];

    expect(titles(orderThreads(rows, "lastActivity"))).toEqual(["alpha", "beta"]);
  });

  it("does not mutate its input", () => {
    const rows = [thread("b", "claude", 1, 1), thread("a", "claude", 2, 2)];
    orderThreads(rows, "name");

    expect(titles(rows)).toEqual(["b", "a"]);
  });
});

describe("order guards", () => {
  it("accepts only the drawn options", () => {
    expect(isProjectOrder("name")).toBe(true);
    expect(isThreadOrder("agent")).toBe(true);
    // `agent` is a THREAD order and must not be accepted for projects — the
    // exact mix-up a shared string union would have allowed.
    expect(isProjectOrder("agent")).toBe(false);
    expect(isProjectOrder("createdAt")).toBe(false);
    expect(isThreadOrder(null)).toBe(false);
    expect(isThreadOrder({ toString: () => "name" })).toBe(false);
  });
});

describe("defaults", () => {
  it("matches the behaviour that ships today, not 73D-0's checkmarks", () => {
    // 73D-0 draws Recently Added checked for projects. Adopting that would
    // reorder every existing sidebar on upgrade, so it stays a flagged
    // question — this pins the decision so a flip is deliberate.
    expect(DEFAULT_PROJECT_ORDER).toBe("lastActivity");
    expect(DEFAULT_THREAD_ORDER).toBe("lastActivity");
  });
});
