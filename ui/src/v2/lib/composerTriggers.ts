/**
 * Composer trigger sources (p2c US-304).
 *
 * v1 hand-rolled the sigil menus (`ComposerAutocomplete.tsx`: caret parsing,
 * debounce, ↑/↓, insert). Astryx's `ChatComposerInput` already owns all of
 * that, so v2 supplies only the DATA — one `SearchSource` per sigil, hitting
 * the same endpoints v1 does:
 *
 *   @  files/folders   GET /api/fs/search?path=<cwd>&q=
 *   $  skills          GET /api/claude/skills          (fetched once, cached)
 *   /  slash commands  GET /api/claude/commands?cwd=   (fetched once, cached)
 *
 * The inserted TOKEN's `value` is the wire format v1 already sends — `@rel`,
 * `$skill`, `/command` — so what the agent receives is unchanged; only the
 * on-screen affordance (an inline chip instead of bare text) is new.
 *
 * No gateway change, no v1 import.
 */
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import { apiBase } from "../../lib/gateway.ts";

/** What a trigger item carries beyond its label — the menu's right-hand hint
 *  and the kind, which decides the row's icon. */
export interface TriggerAux {
  kind: "file" | "dir" | "skill" | "command";
  hint?: string;
}

export type TriggerItem = SearchableItem<TriggerAux>;

async function getJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const r = await fetch(apiBase() + url, {
      headers: { "x-conan-token": token },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

interface FsHit {
  rel: string;
  name: string;
  isDir?: boolean;
}

/** `@` — bounded recursive search under the thread's cwd (v1 US-018). */
export function createFileSource(
  token: string | null,
  cwd: string | null,
): SearchSource<TriggerItem> {
  const search = async (query: string): Promise<TriggerItem[]> => {
    if (!token || !cwd) return [];
    const data = await getJson<{ hits?: FsHit[] }>(
      `/api/fs/search?path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`,
      token,
    );
    return (data?.hits ?? []).slice(0, 25).map((h) => {
      const rel = `${h.rel}${h.isDir ? "/" : ""}`;
      return {
        id: `@${rel}`,
        label: rel,
        auxiliaryData: { kind: h.isDir ? ("dir" as const) : ("file" as const) },
      };
    });
  };
  return { search, bootstrap: () => search("") };
}

interface SkillEntry {
  name: string;
  description?: string | null;
  source?: string;
}

/** `$` — installed skills (user + project + plugin), fetched once (v1 US-019). */
export function createSkillSource(
  token: string | null,
): SearchSource<TriggerItem> {
  let cache: SkillEntry[] | null = null;
  const load = async (): Promise<SkillEntry[]> => {
    if (!token) return [];
    if (!cache) cache = (await getJson<SkillEntry[]>("/api/claude/skills", token)) ?? null;
    return cache ?? [];
  };
  const search = async (query: string): Promise<TriggerItem[]> => {
    const entries = await load();
    return rank(
      entries.map((s) => ({
        key: s.name,
        hint: s.description ?? s.source,
        insert: `$${s.name}`,
        label: s.name,
      })),
      query,
    ).map((e) => ({
      id: e.insert,
      label: e.label,
      auxiliaryData: { kind: "skill" as const, hint: e.hint ?? undefined },
    }));
  };
  return { search, bootstrap: () => search("") };
}

interface CommandEntry {
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  source?: string;
}

/** `/` — custom + headless-safe built-in commands, fetched once (v1 US-020). */
export function createCommandSource(
  token: string | null,
  cwd: string | null,
): SearchSource<TriggerItem> {
  let cache: CommandEntry[] | null = null;
  const load = async (): Promise<CommandEntry[]> => {
    if (!token) return [];
    if (!cache) {
      const url = cwd
        ? `/api/claude/commands?cwd=${encodeURIComponent(cwd)}`
        : "/api/claude/commands";
      cache = (await getJson<CommandEntry[]>(url, token)) ?? null;
    }
    return cache ?? [];
  };
  const search = async (query: string): Promise<TriggerItem[]> => {
    const entries = await load();
    return rank(
      entries.map((c) => ({
        key: c.name,
        // The SOURCE matters here: a project command and a built-in can look
        // alike, but only one is this repo's own workflow (v1's note).
        hint: c.description ? `${c.source} · ${c.description}` : c.source,
        insert: `/${c.name}`,
        label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
      })),
      query,
    ).map((e) => ({
      id: e.insert,
      label: e.label,
      auxiliaryData: { kind: "command" as const, hint: e.hint ?? undefined },
    }));
  };
  return { search, bootstrap: () => search("") };
}

interface Rankable {
  key: string;
  label: string;
  insert: string;
  hint?: string | null;
}

/** v1's ranking: name-prefix, then name-substring, then description — so
 *  typing the first letters of a skill puts it first, not alphabetically. */
function rank<T extends Rankable>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return entries
    .map((e) => {
      const name = e.key.toLowerCase();
      const score = name.startsWith(q)
        ? 0
        : name.includes(q)
          ? 1
          : (e.hint ?? "").toLowerCase().includes(q)
            ? 2
            : -1;
      return { e, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.e.key.localeCompare(b.e.key))
    .slice(0, 25)
    .map((x) => x.e);
}
