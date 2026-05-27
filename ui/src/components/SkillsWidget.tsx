import type { SkillEntry, SkillSource } from "../hooks/useSkills.ts";

/**
 * The Skills HUD tab (US-006): a VS Code Extensions–style list of installed
 * skills from GET /api/claude/skills (US-005). Each row shows the bold skill
 * name, a clamped description (the panel is only ~320px wide), and a source
 * badge (User / Project / Plugin (name) / Built-in). Built-in skills with no
 * readable SKILL.md show name + badge only — the backend never fabricates a
 * description. Flush, panel-native rows (no card chrome) separated by full-width
 * dividers, in keeping with the HUD's continuous-surface direction (US-014).
 * Themed with semantic tokens only.
 */
export default function SkillsWidget({ skills }: { skills: SkillEntry[] }) {
  if (skills.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-muted-foreground">
        No skills installed.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {skills.map((s, i) => (
        <li
          key={`${s.source}:${s.plugin ?? ""}:${s.name}:${i}`}
          className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-b-0"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12px] font-semibold text-foreground">
              {s.name}
            </span>
            <SourceBadge source={s.source} plugin={s.plugin} />
          </div>
          {s.description && (
            <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {s.description}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Small pill tagging a skill's origin; Plugin carries its plugin key. */
function SourceBadge({
  source,
  plugin,
}: {
  source: SkillSource;
  plugin?: string;
}) {
  const label =
    source === "Plugin" && plugin ? `Plugin (${plugin})` : source;
  return (
    <span
      title={label}
      className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      {label}
    </span>
  );
}
