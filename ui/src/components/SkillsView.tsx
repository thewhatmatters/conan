import { useMemo, useState } from "react";
import { useSkillsList, type SkillInfo } from "../hooks/useSkills.ts";
import { Badge } from "./ui/badge.tsx";

type ScopeFilter = "all" | "user" | "project";

/**
 * Skills page (US-028). Browses the global (~/.claude/skills) + active-project
 * (<cwd>/.claude/skills) skills catalog from GET /api/claude/skills/list
 * (US-016): name, description, scope (global vs project) and the active
 * session's loaded state, with each row expandable for details. Project skills
 * follow the toolbar cwd; a search box filters by name/description and a scope
 * toggle narrows by source. shadcn primitives, semantic tokens, light+dark,
 * with loading + empty states.
 */
export default function SkillsView({
  sessionId,
  cwd,
  trigger = 0,
}: {
  sessionId: string | null;
  cwd: string | null;
  trigger?: number;
}) {
  const { skills, loaded } = useSkillsList(sessionId, cwd, trigger);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const counts = useMemo(
    () => ({
      all: skills.length,
      user: skills.filter((s) => s.scope === "user").length,
      project: skills.filter((s) => s.scope === "project").length,
    }),
    [skills],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (scope !== "all" && s.scope !== scope) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, scope]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Global skills from{" "}
        <code className="font-mono">~/.claude/skills</code> and this
        project&apos;s <code className="font-mono">.claude/skills</code>.
      </p>

      {/* Controls: search + scope toggle */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            placeholder="Search skills…"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/50 p-0.5">
          {(["all", "user", "project"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={
                "rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors " +
                (scope === s
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {s === "user" ? "Global" : s} ({counts[s]})
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="mt-4">
        {!loaded ? (
          <Muted>Loading…</Muted>
        ) : skills.length === 0 ? (
          <Empty>
            No skills found. Add one under{" "}
            <code className="font-mono">~/.claude/skills/</code> or the
            project&apos;s <code className="font-mono">.claude/skills/</code>.
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty>No skills match your filters.</Empty>
        ) : (
          <ul className="space-y-2">
            {filtered.map((s) => (
              <SkillRow key={`${s.scope}:${s.source}`} skill={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One expandable skill row. */
function SkillRow({ skill }: { skill: SkillInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <Chevron open={open} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </span>
            <Badge variant={skill.scope === "user" ? "secondary" : "outline"}>
              {skill.scope === "user" ? "global" : "project"}
            </Badge>
            {skill.loaded === true && (
              <Badge variant="default">loaded</Badge>
            )}
          </div>
          {skill.description && (
            <p
              className={
                "mt-1 text-xs text-muted-foreground " +
                (open ? "" : "line-clamp-2")
              }
            >
              {skill.description}
            </p>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {!skill.description && (
            <p className="mb-1 italic">No description in SKILL.md frontmatter.</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="text-foreground">
              {skill.scope === "user" ? "Global (user)" : "Project"}
            </dd>
            <dt className="text-muted-foreground">Loaded</dt>
            <dd className="text-foreground">
              {skill.loaded === null
                ? "unknown (no session init)"
                : skill.loaded
                  ? "yes"
                  : "no"}
            </dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="break-all font-mono text-foreground">
              {skill.source}
            </dd>
          </dl>
        </div>
      )}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={
        "mt-0.5 shrink-0 text-muted-foreground transition-transform " +
        (open ? "rotate-90" : "")
      }
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
