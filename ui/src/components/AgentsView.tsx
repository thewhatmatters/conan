/**
 * Agents page shell (US-017). A placeholder destination at /agents that US-027
 * fills with the custom-agents registry + live background agents. Kept minimal
 * here so routing/nav ships independently. Semantic tokens only.
 */
export default function AgentsView() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Custom agents and background agents.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Agent registry and background agents arrive in a later story.
      </div>
    </div>
  );
}
