import { useEffect } from "react";
import type { ChangelogState } from "../hooks/useChangelog.ts";
import type { DoctorState } from "../hooks/useDoctor.ts";
import DoctorBanner from "./DoctorBanner.tsx";
import { Badge } from "./ui/badge.tsx";

/**
 * What's New page (US-030). Renders the US-007 changelog feed grouped by version
 * (newest-first), highlighting entries newer than Claude Code's
 * lastReleaseNotesSeen marker (`isNew`). On mount it acknowledges the newest
 * entry via `markSeen`, clearing the sidebar's unseen badge. shadcn primitives,
 * semantic tokens, light+dark, with loading + graceful empty states.
 */
export default function WhatsNewView({
  changelog,
  doctor,
}: {
  changelog: ChangelogState;
  doctor: DoctorState;
}) {
  const {
    entries,
    installedVersion,
    lastReleaseNotesSeen,
    changelogLastFetched,
    loaded,
    markSeen,
  } = changelog;

  // Opening the view counts as "seen" — clears the nav badge. Re-run once the
  // feed has loaded so we mark the actual newest version (not an empty list).
  useEffect(() => {
    if (loaded && entries.length > 0) markSeen();
  }, [loaded, entries.length, markSeen]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">What&apos;s New</h1>
        {installedVersion && (
          <Badge variant="secondary">v{installedVersion} installed</Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Claude Code release notes from{" "}
        <code className="font-mono">~/.claude/cache/changelog.md</code>
        {lastReleaseNotesSeen && (
          <>
            {" "}— newest seen by Claude Code:{" "}
            <span className="font-mono">v{lastReleaseNotesSeen}</span>
          </>
        )}
        {changelogLastFetched && (
          <> · updated {new Date(changelogLastFetched).toLocaleDateString()}</>
        )}
        .
      </p>

      {/* US-045: version/update banner + on-demand `claude doctor` health. */}
      <div className="mt-5">
        <DoctorBanner doctor={doctor} />
      </div>

      <div className="mt-5">
        {!loaded ? (
          <Muted>Loading…</Muted>
        ) : entries.length === 0 ? (
          <Empty>
            No changelog found. Claude Code caches it at{" "}
            <code className="font-mono">~/.claude/cache/changelog.md</code> after
            it next checks for updates.
          </Empty>
        ) : (
          <ol className="space-y-4">
            {entries.map((entry) => (
              <li
                key={entry.version}
                className={
                  "rounded-lg border bg-card p-4 " +
                  (entry.isNew
                    ? "border-primary/50 ring-1 ring-primary/20"
                    : "border-border")
                }
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    v{entry.version}
                  </h2>
                  {entry.isNew && <Badge variant="default">New</Badge>}
                  {entry.version === installedVersion && (
                    <Badge variant="outline">installed</Badge>
                  )}
                </div>
                {entry.items.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {entry.items.map((item, i) => (
                      <li
                        key={i}
                        className="flex gap-2 text-sm text-muted-foreground"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                        />
                        <span className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm italic text-muted-foreground">
                    No notes for this release.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
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
