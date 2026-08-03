import { asProviderId, type ProviderId } from "./model.ts";

/** Saved launch identity for a reopened thread. `canResume` is false when the
 * persisted transcript is missing: the next turn starts a fresh session but
 * still keeps the thread's saved provider/model/effort choices. */
export interface ResumeLaunchInput {
  sessionId: string;
  canResume: boolean;
  model: string | null;
  effort: string | null;
  provider: string | null;
}

/** The composer's current launch choices plus thread-scoped routing fields. */
export interface LaunchSelection {
  model?: string;
  permissionMode?: string;
  effort?: string;
  provider: string;
  cwd?: string;
  projectId?: string;
}

/** Canonical options sent with an agent prompt. */
export interface LaunchOpts {
  model?: string;
  permissionMode?: string;
  effort?: string;
  cwd?: string;
  projectId?: string;
  resume?: string;
  provider: ProviderId;
}

/** Resolve saved-thread identity against the user's live composer selection.
 * A reopened thread keeps its original model/effort/provider; permission mode
 * remains live and user-selectable. Fresh threads use the composer throughout. */
export function buildLaunchOpts(
  resume: ResumeLaunchInput | undefined,
  selection: LaunchSelection,
): LaunchOpts {
  return {
    model: resume ? resume.model ?? undefined : selection.model,
    permissionMode: selection.permissionMode,
    effort: resume ? resume.effort ?? undefined : selection.effort || undefined,
    cwd: selection.cwd,
    projectId: selection.projectId,
    resume: resume?.canResume ? resume.sessionId : undefined,
    provider: resume ? asProviderId(resume.provider) : asProviderId(selection.provider),
  };
}
