import { describe, expect, it } from "vitest";
import {
  buildLaunchOpts,
  type LaunchSelection,
  type ResumeLaunchInput,
} from "../launch.ts";

const selection: LaunchSelection = {
  model: "sonnet",
  permissionMode: "acceptEdits",
  effort: "think",
  provider: "codex",
  cwd: "/repo/worktree",
  projectId: "project-1",
};

const resume: ResumeLaunchInput = {
  sessionId: "session-1",
  canResume: true,
  model: "opus",
  effort: "ultrathink",
  provider: "claude",
};

describe("buildLaunchOpts", () => {
  it("uses the selected model, effort, provider, and permission mode for a fresh thread", () => {
    expect(buildLaunchOpts(undefined, selection)).toEqual({
      model: "sonnet",
      permissionMode: "acceptEdits",
      effort: "think",
      cwd: "/repo/worktree",
      projectId: "project-1",
      resume: undefined,
      provider: "codex",
    });
  });

  it("keeps saved identity and adds the session id for a resumed thread", () => {
    expect(buildLaunchOpts(resume, selection)).toEqual({
      model: "opus",
      permissionMode: "acceptEdits",
      effort: "ultrathink",
      cwd: "/repo/worktree",
      projectId: "project-1",
      resume: "session-1",
      provider: "claude",
    });
  });

  it("lets the user override permission mode on resume without replacing saved identity", () => {
    expect(
      buildLaunchOpts(resume, {
        ...selection,
        model: "haiku",
        effort: "think",
        provider: "grok",
        permissionMode: "plan",
      }),
    ).toMatchObject({
      model: "opus",
      effort: "ultrathink",
      provider: "claude",
      permissionMode: "plan",
    });
  });

  it("starts fresh when history is missing but preserves the saved launch choices", () => {
    expect(buildLaunchOpts({ ...resume, canResume: false }, selection)).toMatchObject({
      model: "opus",
      effort: "ultrathink",
      provider: "claude",
      resume: undefined,
    });
  });

  it("omits empty fresh-thread effort and narrows unknown provider ids", () => {
    expect(
      buildLaunchOpts(undefined, { ...selection, effort: "", provider: "typo-provider" }),
    ).toMatchObject({ effort: undefined, provider: "claude" });
  });
});
