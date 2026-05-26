import { useCallback, useEffect, useState } from "react";

/** One parsed release from the changelog (mirrors the gateway's ChangelogEntry). */
export interface ChangelogEntry {
  version: string;
  date: null;
  items: string[];
  /** True when this version is newer than ~/.claude.json's lastReleaseNotesSeen. */
  isNew: boolean;
}

export interface ChangelogState {
  entries: ChangelogEntry[];
  installedVersion: string | null;
  lastReleaseNotesSeen: string | null;
  changelogLastFetched: number | null;
  /** True until the first fetch settles. */
  loaded: boolean;
  /** Count of `isNew` entries the user hasn't acknowledged in Conan yet. */
  unseenCount: number;
  /** Mark the newest entry as seen locally (clears the nav badge). */
  markSeen: () => void;
}

/** localStorage marker for the newest version the user has viewed in Conan. */
const SEEN_KEY = "conan.whatsnew.seen";

/** Compare two version strings as numeric semver tuples. >0 when a is newer. */
function semverCompare(a: string, b: string): number {
  const ta = a.trim().split(".").map((p) => parseInt(p, 10) || 0);
  const tb = b.trim().split(".").map((p) => parseInt(p, 10) || 0);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const diff = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Loads the "What's New" changelog feed (US-030) from GET /api/claude/changelog
 * (US-007): newest-first releases, each flagged `isNew` when newer than Claude
 * Code's lastReleaseNotesSeen marker. On top of that backend flag we track a
 * local "seen" version in localStorage so the nav badge clears once the user
 * actually opens the What's New view — `unseenCount` is the number of `isNew`
 * entries newer than that local marker, and `markSeen()` acknowledges them.
 * Refetches on each WS event (via `trigger`) so new releases surface live.
 */
export function useChangelog(trigger: number | null): ChangelogState {
  const [data, setData] = useState<{
    entries: ChangelogEntry[];
    installedVersion: string | null;
    lastReleaseNotesSeen: string | null;
    changelogLastFetched: number | null;
    loaded: boolean;
  }>({
    entries: [],
    installedVersion: null,
    lastReleaseNotesSeen: null,
    changelogLastFetched: null,
    loaded: false,
  });
  // Local acknowledgement marker; bumped by markSeen so unseenCount recomputes.
  const [seen, setSeen] = useState<string | null>(() =>
    localStorage.getItem(SEEN_KEY),
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/changelog")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setData({
          entries: Array.isArray(d?.entries) ? (d.entries as ChangelogEntry[]) : [],
          installedVersion:
            typeof d?.installedVersion === "string" ? d.installedVersion : null,
          lastReleaseNotesSeen:
            typeof d?.lastReleaseNotesSeen === "string"
              ? d.lastReleaseNotesSeen
              : null,
          changelogLastFetched:
            typeof d?.changelogLastFetched === "number"
              ? d.changelogLastFetched
              : null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setData((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [trigger]);

  const unseenCount = data.entries.filter(
    (e) => e.isNew && (!seen || semverCompare(e.version, seen) > 0),
  ).length;

  const markSeen = useCallback(() => {
    setData((d) => {
      const newest = d.entries[0]?.version ?? null;
      if (newest) {
        localStorage.setItem(SEEN_KEY, newest);
        setSeen(newest);
      }
      return d;
    });
  }, []);

  return { ...data, unseenCount, markSeen };
}
