import { useState } from "react";
import type { SkillEntry } from "../hooks/useSkills.ts";

/** "User" group = your own skills (User + Project); "System" = Plugin + Built-in. */
type Group = "user" | "system";
const isUserSkill = (s: SkillEntry) =>
  s.source === "User" || s.source === "Project";

/**
 * The Skills HUD tab (US-006): a VS Code Extensions–style list of installed
 * skills from GET /api/claude/skills (US-005). A flat tab group at the top splits
 * them into **User** (your own ~/.claude + project skills) and **System** (Plugin
 * + Built-in), each with its count, so the two are easy to tell apart. Each row
 * shows the bold skill name, a clamped description (the panel is only ~320px
 * wide), and the skill's on-disk **path** (home-relative `~/…`) in place of a
 * source badge. Built-in skills with no readable SKILL.md show name only (+ a
 * "built-in" marker) — the backend never fabricates a description. Flush, panel-native
 * rows (no card chrome) per the HUD's continuous-surface direction (US-014).
 * Themed with semantic tokens only.
 */
export default function SkillsWidget({ skills }: { skills: SkillEntry[] }) {
  const user = skills.filter(isUserSkill);
  const system = skills.filter((s) => !isUserSkill(s));
  // Default to whichever group has skills, preferring User.
  const [group, setGroup] = useState<Group>(
    user.length === 0 && system.length > 0 ? "system" : "user",
  );

  if (skills.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-muted-foreground">
        No skills installed.
      </p>
    );
  }

  const shown = group === "user" ? user : system;

  return (
    <div className="flex min-h-0 flex-col">
      {/* Flat tab group: User (N) / System (N) — matches the HUD's tab styling. */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <GroupTab
          label="User"
          count={user.length}
          active={group === "user"}
          onClick={() => setGroup("user")}
        />
        <GroupTab
          label="System"
          count={system.length}
          active={group === "system"}
          onClick={() => setGroup("system")}
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-muted-foreground">
          No {group} skills.
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((s, i) => (
            <li
              key={`${s.source}:${s.plugin ?? ""}:${s.name}:${i}`}
              className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-b-0"
            >
              <span className="truncate text-[12px] font-semibold text-foreground">
                {s.name}
              </span>
              {s.description && (
                <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {s.description}
                </p>
              )}
              {typeof s.lastFiredAt === "number" && (
                <span className="text-[10px] text-muted-foreground/70">
                  last fired {formatAgo(s.lastFiredAt)}
                </span>
              )}
              <SkillPath path={s.path} plugin={s.plugin} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One tab in the User/System group, with its skill count. */
function GroupTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md px-2.5 py-1 text-xs font-normal transition-colors " +
        (active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60")
      }
    >
      {label}{" "}
      <span className={active ? "text-muted-foreground" : "opacity-60"}>
        {count}
      </span>
    </button>
  );
}

/**
 * Compact "X ago" formatter for the last-fired stamp. The transcript scan only
 * runs on session events, so the precision the user sees is "minutes" at best —
 * we render minutes under an hour, hours under a day, days otherwise. "just now"
 * for sub-minute firings keeps the line honest without showing seconds.
 */
function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Where the skill lives on disk (home-relative `~/…`) — shown in place of the
 * old source badge. Built-in harness skills have no path, so they render a plain
 * "built-in" marker. Truncated to fit the ~320px panel; the full path is the
 * `title` tooltip.
 */
function SkillPath({ path, plugin }: { path?: string; plugin?: string }) {
  if (!path) {
    return (
      <span className="text-[10px] italic text-muted-foreground/70">
        built-in
      </span>
    );
  }
  const full = plugin ? `${path}  ·  ${plugin}` : path;
  return (
    <code
      title={full}
      className="truncate font-mono text-[10px] text-muted-foreground/80"
    >
      {path}
    </code>
  );
}
