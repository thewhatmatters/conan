import {
  useAgents,
  type BackgroundAgent,
  type CustomAgent,
} from "../hooks/useAgents.ts";
import { Badge } from "./ui/badge.tsx";
import StatusDot from "./shared/StatusDot.tsx";
import { relativeTime } from "./shared/TimeAgo.tsx";

/**
 * Agents page (US-027). Three sections at /agents:
 *   1. Custom-agents registry (US-012) — name, role/description, scope, tools.
 *   2. Live background agents (US-013) — pid/cwd/kind/started, with status.
 *      Read-only ("view"); no stop control is exposed because the gateway has
 *      no background-agent stop surface (the CLI only lists), so we don't
 *      fabricate one. The list itself is fetched behind the auth token.
 *   3. Agent teams / worktree runs — placeholder until that data exists.
 * shadcn primitives, semantic tokens, light+dark, with empty/loading states.
 */
export default function AgentsView({
  token,
  trigger = 0,
}: {
  token: string | null;
  trigger?: number;
}) {
  const { custom, background, backgroundAvailable, backgroundError, loaded } =
    useAgents(token, trigger);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The custom agents you&apos;ve defined and the background agents running now.
      </p>

      <div className="mt-6 space-y-6">
        {/* Custom-agents registry (US-012) */}
        <Section
          title="Custom agents"
          desc="Agent definitions from ~/.claude/agents (user) and this project's .claude/agents."
          count={custom.length}
        >
          {!loaded ? (
            <Muted>Loading…</Muted>
          ) : custom.length === 0 ? (
            <Empty>
              No custom agents found. Add one under{" "}
              <code className="font-mono">~/.claude/agents/</code> or the
              project&apos;s <code className="font-mono">.claude/agents/</code>.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {custom.map((a) => (
                <CustomAgentRow key={`${a.scope}:${a.source}`} agent={a} />
              ))}
            </ul>
          )}
        </Section>

        {/* Live background agents (US-013) */}
        <Section
          title="Background agents"
          desc="Live Claude Code sessions reported by the CLI."
          count={backgroundAvailable ? background.length : undefined}
        >
          {!loaded ? (
            <Muted>Loading…</Muted>
          ) : !backgroundAvailable ? (
            <Empty>
              Background agents unavailable
              {backgroundError ? ` — ${backgroundError}.` : "."}
            </Empty>
          ) : background.length === 0 ? (
            <Empty>No background agents are running.</Empty>
          ) : (
            <ul className="space-y-2">
              {background.map((a, i) => (
                <BackgroundAgentRow key={a.sessionId ?? a.pid ?? i} agent={a} />
              ))}
            </ul>
          )}
        </Section>

        {/* Agent teams / worktree runs — placeholder (no data source yet) */}
        <Section
          title="Teams & worktree runs"
          desc="Multi-agent teams and worktree-isolated runs will appear here."
        >
          <Empty>
            No teams or worktree runs yet. Worktree-isolated driven sessions
            arrive in a later story.
          </Empty>
        </Section>
      </div>
    </div>
  );
}

/** One row in the custom-agents registry. */
function CustomAgentRow({ agent }: { agent: CustomAgent }) {
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {agent.name}
        </span>
        <Badge variant={agent.scope === "user" ? "secondary" : "outline"}>
          {agent.scope}
        </Badge>
      </div>
      {(agent.description || agent.role) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {agent.description ?? agent.role}
        </p>
      )}
      {agent.tools && agent.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {agent.tools.map((t) => (
            <span
              key={t}
              className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/** One row for a live background agent. */
function BackgroundAgentRow({ agent }: { agent: BackgroundAgent }) {
  const status = agent.status ?? "running";
  const isIdle = status.toLowerCase() === "idle";
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm text-foreground">
          {agent.sessionId ? agent.sessionId.slice(0, 8) : "unknown"}
          {agent.kind ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {agent.kind}
            </span>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot
            status={isIdle ? "idle" : "running"}
            ping={false}
            tone={isIdle ? "bg-muted-foreground/50" : "bg-primary"}
          />
          {status}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        {agent.cwd && <span className="truncate font-mono">{agent.cwd}</span>}
        {agent.pid != null && <span>pid {agent.pid}</span>}
        {agent.startedAt != null && (
          <span title={new Date(agent.startedAt).toLocaleString()}>
            started {relativeTime(agent.startedAt)}
          </span>
        )}
      </div>
    </li>
  );
}

function Section({
  title,
  desc,
  count,
  children,
}: {
  title: string;
  desc?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {count != null && (
          <span className="text-xs text-muted-foreground">{count}</span>
        )}
      </div>
      {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
