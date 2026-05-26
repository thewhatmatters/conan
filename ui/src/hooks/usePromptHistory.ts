import { useEffect, useState } from "react";

/** One prompt-history entry (mirrors the gateway's PromptHistoryEntry, US-015). */
export interface PromptHistoryEntry {
  display: string;
  /** Epoch ms, or null when absent/unparseable. */
  timestamp: number | null;
  /** The cwd the prompt was issued in, or null. */
  project: string | null;
}

export interface PromptHistoryResult {
  entries: PromptHistoryEntry[];
  /** Count of entries matching the filters, before limit/offset. */
  total: number;
  limit: number;
  offset: number;
}

export interface PromptHistoryState extends PromptHistoryResult {
  /** True until the first fetch settles. */
  loaded: boolean;
  /** True while a fetch (including page/filter changes) is in flight. */
  loading: boolean;
}

export interface UsePromptHistoryOptions {
  q?: string;
  project?: string;
  limit?: number;
  offset?: number;
  /** Bump to force a refetch (e.g. on new WS events). */
  trigger?: number;
}

const EMPTY: PromptHistoryResult = {
  entries: [],
  total: 0,
  limit: 0,
  offset: 0,
};

/**
 * Loads a page of the user's Claude Code prompt history (US-034) from
 * GET /api/claude/prompt-history (US-015): newest-first, with optional ?q= text
 * search, ?project= filter, and ?limit=/?offset= server-side pagination. `total`
 * is the matched-set size before pagination, so the view can render page
 * controls. Refetches whenever the query, filter, page, or trigger changes.
 * Missing file / network error → empty result (never throws).
 */
export function usePromptHistory(
  opts: UsePromptHistoryOptions = {},
): PromptHistoryState {
  const { q, project, limit, offset, trigger } = opts;
  const [state, setState] = useState<PromptHistoryState>({
    ...EMPTY,
    loaded: false,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (project) qs.set("project", project);
    if (limit != null) qs.set("limit", String(limit));
    if (offset != null) qs.set("offset", String(offset));
    const suffix = qs.toString();
    fetch(`/api/claude/prompt-history${suffix ? `?${suffix}` : ""}`)
      .then((r) => r.json())
      .then((d: Partial<PromptHistoryResult>) => {
        if (cancelled) return;
        setState({
          entries: Array.isArray(d?.entries) ? d.entries : [],
          total: typeof d?.total === "number" ? d.total : 0,
          limit: typeof d?.limit === "number" ? d.limit : (limit ?? 0),
          offset: typeof d?.offset === "number" ? d.offset : (offset ?? 0),
          loaded: true,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled)
          setState({ ...EMPTY, loaded: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [q, project, limit, offset, trigger]);

  return state;
}
