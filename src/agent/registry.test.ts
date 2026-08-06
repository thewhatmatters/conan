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
  resolveRequestedProvider,
  CODEX_CAPABILITIES,
  GROK_CAPABILITIES,
  capabilitiesFor,
  capabilitiesForReportedModel,
  contextWindowFor,
} from "./registry.js";
import { CLAUDE_CAPABILITIES } from "./claude.js";

beforeEach(() => clearProviderDetection());

test("registry lists exactly claude/codex/grok/kimi with their avatar letters", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => [p.id, p.avatarLetter, p.binary]),
    [
      ["claude", "C", "claude"],
      ["codex", "X", "codex"],
      ["grok", "G", "grok"],
      ["kimi", "K", "kimi"],
    ],
  );
  assert.equal(getProvider("codex")?.name, "Codex");
  assert.equal(getProvider("nope"), undefined);
});

// WHA-100: PROVIDERS ids must stay set-equal to the UI's PROVIDER_IDS (the
// compile-time Record in ui/src/chat/model.ts). Hard-coded here so the gateway
// suite never imports the UI program; the UI suite asserts the same set via
// PROVIDER_IDS and PROVIDER_ICON keys.
test("PROVIDERS ids cover the ProviderId union (≡ UI PROVIDER_IDS)", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id).slice().sort(), [
    "claude",
    "codex",
    "grok",
    "kimi",
  ]);
});

test("context-window lookup returns only verified model sizes", () => {
  assert.equal(contextWindowFor("claude"), 200_000);
  assert.equal(contextWindowFor("claude", "sonnet"), 200_000);
  assert.equal(contextWindowFor("claude", "opus"), 1_000_000);
  assert.equal(contextWindowFor("claude", "fable"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-opus-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-fable-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-sonnet-5"), 200_000);
  assert.equal(contextWindowFor("claude", "claude-3-opus-20240229"), 200_000);
  assert.equal(contextWindowFor("claude", "claude-3-5-sonnet-20241022"), 200_000);
  // Date/build suffixes fall back to the longest matching verified base slug.
  assert.equal(contextWindowFor("claude", "claude-opus-5-20241022"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-fable-5-20241022"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-sonnet-5-20241022"), 200_000);
  assert.equal(contextWindowFor("claude", "claude-opus-4-7-20241022"), null);
  // Claude's bracketed window hints (e.g. `claude-opus-5[1m]`) are normalized
  // to the base slug before lookup.
  assert.equal(contextWindowFor("claude", "claude-opus-5[1m]"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-sonnet-5[200k]"), 200_000);
  assert.equal(contextWindowFor("claude", "claude-opus-4-7[1m]"), null);
  assert.equal(contextWindowFor("codex", "gpt-5.6-sol"), 272_000);
  assert.equal(contextWindowFor("codex", "gpt-5.3-codex-spark"), 128_000);
  assert.equal(contextWindowFor("grok"), 500_000);
  assert.equal(contextWindowFor("grok", "grok-4.5"), 500_000);
  assert.equal(contextWindowFor("codex"), null);
  assert.equal(contextWindowFor("codex", "future-model"), null);
  assert.equal(contextWindowFor("grok", "grok-4.5-build"), null);
});

test("per-launch capabilities expose the selected model window", () => {
  const provider = getProvider("codex")!;
  const resolved = capabilitiesFor(provider, "gpt-5.4-mini");
  assert.equal(resolved.contextWindowTokens, 272_000);
  assert.equal(resolved.permissionModes, provider.capabilities.permissionModes);
  assert.equal(capabilitiesFor(provider, "unknown").contextWindowTokens, null);
});

test("reported-model resolution replaces the provisional launch denominator", () => {
  const claude = getProvider("claude")!;
  assert.equal(capabilitiesFor(claude).contextWindowTokens, 200_000);
  assert.equal(
    capabilitiesForReportedModel(claude, "claude-fable-5").contextWindowTokens,
    1_000_000,
  );
  assert.equal(
    capabilitiesForReportedModel(claude, "future-claude").contextWindowTokens,
    null,
  );
  assert.equal(
    capabilitiesForReportedModel(getProvider("grok")!, "grok-4.5-build")
      .contextWindowTokens,
    null,
  );
  assert.equal(
    capabilitiesForReportedModel(getProvider("codex")!, null).contextWindowTokens,
    null,
  );
});

test("capabilities pin the US-001 verified matrix", () => {
  // codex: no deltas, no approval, no live switch, no USD, no reasoning text.
  assert.equal(CODEX_CAPABILITIES.streamingDeltas, false);
  assert.equal(CODEX_CAPABILITIES.imageInput, true);
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
  assert.equal(GROK_CAPABILITIES.imageInput, true);
  assert.equal(GROK_CAPABILITIES.reasoningText, true);
  assert.equal(GROK_CAPABILITIES.costUsd, true);
  assert.equal(GROK_CAPABILITIES.interactiveApproval, false);
  assert.equal(GROK_CAPABILITIES.livePermissionSwitch, false);
  assert.equal(GROK_CAPABILITIES.resume, true);

  // claude: reasoningText stays FALSE (D2 — headless redaction).
  assert.equal(getProvider("claude")?.capabilities, CLAUDE_CAPABILITIES);
  assert.equal(CLAUDE_CAPABILITIES.reasoningText, false);
  assert.equal(CLAUDE_CAPABILITIES.imageInput, true);
});

test("every provider exposes a launch-model list with a null-valued default first", () => {
  for (const p of PROVIDERS) {
    const { models, modelSelection } = p.capabilities;
    assert.ok(models.length >= 1, `${p.id} has at least a default model`);
    assert.equal(models[0]!.value, null, `${p.id}'s first model is the default (null)`);
    // A provider that advertises a picker must offer more than just the default.
    if (modelSelection) {
      assert.ok(models.length > 1, `${p.id} advertises modelSelection so offers a choice`);
    }
    // Every non-default value is a real `-m` id string (never null past index 0).
    for (const m of models.slice(1)) {
      assert.equal(typeof m.value, "string", `${p.id} model "${m.label}" has a string value`);
    }
  }
});

test("codex and grok now advertise model selection with their verified ids", () => {
  assert.equal(CODEX_CAPABILITIES.modelSelection, true);
  assert.ok(
    CODEX_CAPABILITIES.models.some((m) => m.value === "gpt-5.6-sol"),
    "codex lists a verified CLI-cache model",
  );
  // codex-auto-review is an internal review model — must stay out of the picker.
  assert.ok(!CODEX_CAPABILITIES.models.some((m) => m.value === "codex-auto-review"));

  assert.equal(GROK_CAPABILITIES.modelSelection, true);
  assert.ok(GROK_CAPABILITIES.models.some((m) => m.value === "grok-4.5"));
  // The build name grok REPORTS is never a selectable launch id.
  assert.ok(!GROK_CAPABILITIES.models.some((m) => m.value === "grok-4.5-build"));
});

test("every provider's factory builds a driver tagged with its own id", () => {
  for (const id of ["claude", "codex", "grok"] as const) {
    const driver = getProvider(id)!.createDriver(
      () => {},
      () => null,
    );
    assert.equal(driver.provider, id);
    driver.dispose();
  }
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

// US-007: an explicit launch-frame provider is honored or refused loudly —
// never a silent fallback to claude.
test("resolveRequestedProvider: unknown id throws a readable error", async () => {
  await assert.rejects(
    resolveRequestedProvider("cursor"),
    /Unknown provider "cursor" \(available: claude, codex, grok, kimi\)/,
  );
});

test("resolveRequestedProvider: uninstalled provider throws, names the binary", async () => {
  await assert.rejects(
    resolveRequestedProvider("codex", async () => {
      throw new Error("command -v exited 1");
    }),
    /Codex is not installed — "codex" was not found on the login-shell PATH/,
  );
});

test("resolveRequestedProvider: installed provider resolves to its entry", async () => {
  const entry = await resolveRequestedProvider("grok", async (cmd) =>
    cmd.startsWith("command -v") ? "/Users/x/.local/bin/grok" : "0.2.111",
  );
  assert.equal(entry, getProvider("grok"));
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
  await detectProvider("kimi", async () => {
    throw new Error("not found");
  });
  const statuses = await listProviderStatuses();
  assert.deepEqual(
    statuses.map((s) => [s.id, s.installed]),
    [
      ["claude", true],
      ["codex", false],
      ["grok", true],
      ["kimi", false],
    ],
  );
  const grok = statuses.find((s) => s.id === "grok")!;
  assert.equal(grok.avatarLetter, "G");
  assert.equal(grok.version, "0.2.111");
  assert.equal(grok.capabilities, GROK_CAPABILITIES);
});
