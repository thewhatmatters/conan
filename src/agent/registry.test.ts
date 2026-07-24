// US-003 provider registry: the table shape, the capability descriptors pinned
// to the US-001 verified matrix (fixtures/README.md), and the install probe's
// never-throw contract. The probe's shell runner is injected so these tests
// never spawn a real login shell. Run with `npm test`.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  getProvider,
  parseVersion,
  probeInstall,
  detectProvider,
  clearProviderDetection,
  listProviderStatuses,
  CODEX_CAPABILITIES,
  GROK_CAPABILITIES,
} from "./registry.js";
import { CLAUDE_CAPABILITIES } from "./claude.js";

beforeEach(() => clearProviderDetection());

test("registry lists exactly claude/codex/grok with their avatar letters", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => [p.id, p.avatarLetter, p.binary]),
    [
      ["claude", "C", "claude"],
      ["codex", "X", "codex"],
      ["grok", "G", "grok"],
    ],
  );
  assert.equal(getProvider("codex")?.name, "Codex");
  assert.equal(getProvider("nope"), undefined);
});

test("capabilities pin the US-001 verified matrix", () => {
  // codex: no deltas, no approval, no live switch, no USD, no reasoning text.
  assert.equal(CODEX_CAPABILITIES.streamingDeltas, false);
  assert.equal(CODEX_CAPABILITIES.interactiveApproval, false);
  assert.equal(CODEX_CAPABILITIES.livePermissionSwitch, false);
  assert.equal(CODEX_CAPABILITIES.costUsd, false);
  assert.equal(CODEX_CAPABILITIES.reasoningText, false);
  assert.equal(CODEX_CAPABILITIES.resume, true);
  // codex permissions are sandbox policies, not approval modes — Supervised
  // must be ABSENT (US-009's honesty requirement).
  assert.deepEqual(
    CODEX_CAPABILITIES.permissionModes.map((m) => m.id),
    ["read-only", "workspace-write", "danger-full-access"],
  );

  // grok: deltas + REAL reasoning text + USD, but no approval channel and no
  // live switch (open questions (a)/(b), both answered NO).
  assert.equal(GROK_CAPABILITIES.streamingDeltas, true);
  assert.equal(GROK_CAPABILITIES.reasoningText, true);
  assert.equal(GROK_CAPABILITIES.costUsd, true);
  assert.equal(GROK_CAPABILITIES.interactiveApproval, false);
  assert.equal(GROK_CAPABILITIES.livePermissionSwitch, false);
  assert.equal(GROK_CAPABILITIES.resume, true);

  // claude: reasoningText stays FALSE (D2 — headless redaction).
  assert.equal(getProvider("claude")?.capabilities, CLAUDE_CAPABILITIES);
  assert.equal(CLAUDE_CAPABILITIES.reasoningText, false);
});

test("claude/codex factories build drivers; grok's throws until US-005", () => {
  for (const id of ["claude", "codex"] as const) {
    const driver = getProvider(id)!.createDriver(
      () => {},
      () => null,
    );
    assert.equal(driver.provider, id);
    driver.dispose();
  }
  assert.throws(() => getProvider("grok")!.createDriver(() => {}, () => null), /US-005/);
});

test("parseVersion handles bare and prefixed version output", () => {
  assert.equal(parseVersion("codex-cli 0.144.6"), "0.144.6");
  assert.equal(parseVersion("0.2.111"), "0.2.111");
  assert.equal(parseVersion("2.1.218 (Claude Code)"), "2.1.218");
  assert.equal(parseVersion("no version here"), null);
});

test("probeInstall: missing binary is installed:false, never a throw", async () => {
  const r = await probeInstall("codex", async () => {
    throw new Error("command -v exited 1");
  });
  assert.deepEqual(r, { installed: false, version: null });
});

test("probeInstall: empty resolution is installed:false", async () => {
  const r = await probeInstall("grok", async () => "");
  assert.deepEqual(r, { installed: false, version: null });
});

test("probeInstall: resolved path + version", async () => {
  const calls: string[] = [];
  const r = await probeInstall("codex", async (cmd) => {
    calls.push(cmd);
    return cmd.startsWith("command -v") ? "/Users/x/.local/bin/codex" : "codex-cli 0.144.6";
  });
  assert.deepEqual(r, { installed: true, version: "0.144.6" });
  assert.deepEqual(calls, ["command -v codex", '"/Users/x/.local/bin/codex" --version']);
});

test("probeInstall: --version failure still counts as installed", async () => {
  const r = await probeInstall("grok", async (cmd) => {
    if (cmd.startsWith("command -v")) return "/Users/x/.local/bin/grok";
    throw new Error("boom");
  });
  assert.deepEqual(r, { installed: true, version: null });
});

test("detectProvider caches within the TTL", async () => {
  let probes = 0;
  const run = async (cmd: string) => {
    if (cmd.startsWith("command -v")) {
      probes++;
      return "/Users/x/.local/bin/grok";
    }
    return "0.2.111";
  };
  const first = await detectProvider("grok", run);
  const second = await detectProvider("grok", run);
  assert.equal(probes, 1);
  assert.equal(second, first);
  assert.equal(first.installed, true);
  assert.equal(first.version, "0.2.111");
});

test("listProviderStatuses carries identity + capabilities per provider", async () => {
  // Seed the cache with fakes so no real shell is spawned.
  await detectProvider("claude", async () => "/usr/local/bin/claude\n");
  await detectProvider("codex", async () => {
    throw new Error("not found");
  });
  await detectProvider("grok", async (cmd) =>
    cmd.startsWith("command -v") ? "/Users/x/.local/bin/grok" : "0.2.111",
  );
  const statuses = await listProviderStatuses();
  assert.deepEqual(
    statuses.map((s) => [s.id, s.installed]),
    [
      ["claude", true],
      ["codex", false],
      ["grok", true],
    ],
  );
  const grok = statuses.find((s) => s.id === "grok")!;
  assert.equal(grok.avatarLetter, "G");
  assert.equal(grok.version, "0.2.111");
  assert.equal(grok.capabilities, GROK_CAPABILITIES);
});
