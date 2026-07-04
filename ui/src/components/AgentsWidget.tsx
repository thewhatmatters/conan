import type { AgentEntry } from "../hooks/useAgents.ts";
import FadeScroll from "./FadeScroll.tsx";
import HudTabHeader from "./shared/HudTabHeader.tsx";

/**
 * The Agents HUD tab: a flush list of installed Claude Code subagents from
 * GET /api/claude/agents — user (~/.claude/agents), project (.claude/agents),
 * and plugin agent `.md` files. Each row shows the bold agent name, a clamped
 * frontmatter description, an optional tools/model metadata line, and the
 * agent's on-disk path (home-relative `~/…`). Unlike Skills there's no
 * User/System split — agent counts stay small, so one list under a pinned
 * count header reads better. An agent without a readable description renders
 * name-only — the backend never fabricates one. Flush, panel-native rows (no
 * card chrome) per the HUD's continuous-surface direction. Semantic tokens
 * only.
 */
export default function AgentsWidget({ agents }: { agents: AgentEntry[] }) {
  if (agents.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-muted-foreground">
        No agents installed.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HudTabHeader
        name={
          <span className="px-1 text-[11px] font-medium text-muted-foreground">
            Agents{" "}
            <span className="opacity-60">{agents.length}</span>
          </span>
        }
      />

      <FadeScroll>
        <ul className="flex flex-col">
          {agents.map((a, i) => (
            <li
              key={`${a.source}:${a.plugin ?? ""}:${a.name}:${i}`}
              className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-b-0"
            >
              <span className="truncate text-[12px] font-semibold text-foreground">
                {a.name}
              </span>
              {a.description && (
                <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {a.description}
                </p>
              )}
              <AgentMeta tools={a.tools} model={a.model} />
              <AgentPath path={a.path} plugin={a.plugin} />
            </li>
          ))}
        </ul>
      </FadeScroll>
    </div>
  );
}

/**
 * One-line tools/model metadata from the agent's frontmatter. Truncated to fit
 * the ~320px panel; the full value rides the `title` tooltip. Rendered only
 * when the frontmatter actually carries the field — never fabricated.
 */
function AgentMeta({
  tools,
  model,
}: {
  tools?: string | null;
  model?: string | null;
}) {
  const parts: string[] = [];
  if (model) parts.push(`model: ${model}`);
  if (tools) parts.push(`tools: ${tools}`);
  if (parts.length === 0) return null;
  const full = parts.join("  ·  ");
  return (
    <span
      title={full}
      className="truncate text-[10px] text-muted-foreground/70"
    >
      {full}
    </span>
  );
}

/**
 * Where the agent lives on disk (home-relative `~/…`) — same presentation as
 * the Skills tab's path line. Plugin key appended in the tooltip.
 */
function AgentPath({ path, plugin }: { path?: string; plugin?: string }) {
  if (!path) return null;
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
