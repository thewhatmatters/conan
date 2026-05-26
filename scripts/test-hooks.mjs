// US-002 test: multi-project global hook installer + cwd-filtered event query.
//
// Pure-module coverage of the merge/remove logic (idempotent, non-clobbering,
// absolute command path), then a gateway round-trip:
//   - POST /api/claude/hooks/install-global is token-gated; installs into a
//     temp ~/.claude/settings.json (via CONAN_GLOBAL_SETTINGS) without losing
//     pre-existing user hooks/keys; re-running is a no-op
//   - events ingested from ANY cwd persist with that cwd and are filterable via
//     GET /api/claude/events?cwd=
//
// Run: tsx scripts/test-hooks.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-hooks-test-"));
const dataDir = path.join(tmp, "data");
const globalSettings = path.join(tmp, "home-claude", "settings.json");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.CONAN_GLOBAL_SETTINGS = globalSettings;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- pure merge/remove logic -------------------------------------------
  const hooks = await import("../src/hooks/install.ts");

  check(
    "conanHookCommand uses an ABSOLUTE path to send-event.mjs",
    path.isAbsolute(hooks.SEND_EVENT_SCRIPT) &&
      hooks.conanHookCommand().includes(hooks.SEND_EVENT_SCRIPT),
  );

  // Pre-existing user config with an unrelated hook + an unknown top-level key.
  const userPrior = {
    $schema: "https://example/schema.json",
    model: "opus",
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "echo my-own-hook" }] },
      ],
    },
  };
  const m1 = hooks.mergeGlobalHooks(userPrior);
  check("merge reports changed on first install", m1.changed === true);
  check(
    "merge preserves an unknown top-level key",
    m1.settings.model === "opus" && m1.settings.$schema === userPrior.$schema,
  );
  check(
    "merge preserves the user's pre-existing SessionStart hook",
    m1.settings.hooks.SessionStart.some((g) =>
      g.hooks?.some((h) => h.command === "echo my-own-hook"),
    ),
  );
  check(
    "merge ADDS the Conan SessionStart group alongside it",
    m1.settings.hooks.SessionStart.some((g) =>
      g.hooks?.some((h) => h.command.includes(hooks.SEND_EVENT_SCRIPT)),
    ),
  );
  check(
    "merge wires all 9 Conan events",
    hooks.CONAN_HOOK_EVENTS.every((e) =>
      m1.settings.hooks[e]?.some((g) =>
        g.hooks?.some((h) => h.command?.includes(hooks.SEND_EVENT_SCRIPT)),
      ),
    ),
  );
  check(
    "PreToolUse/PostToolUse Conan groups carry an empty matcher",
    ["PreToolUse", "PostToolUse"].every((e) =>
      m1.settings.hooks[e].some(
        (g) =>
          g.matcher === "" &&
          g.hooks?.some((h) => h.command.includes(hooks.SEND_EVENT_SCRIPT)),
      ),
    ),
  );
  check("merge does not mutate its input", userPrior.hooks.SessionStart.length === 1);

  // Idempotency: merging the already-merged result adds nothing.
  const m2 = hooks.mergeGlobalHooks(m1.settings);
  check("re-merge is idempotent (changed=false)", m2.changed === false);
  check(
    "re-merge does not duplicate the Conan SessionStart group",
    m2.settings.hooks.SessionStart.filter((g) =>
      g.hooks?.some((h) => h.command.includes(hooks.SEND_EVENT_SCRIPT)),
    ).length === 1,
  );

  // Remove drops only Conan groups, keeps the user's own + prunes emptied keys.
  const r1 = hooks.removeGlobalHooks(m1.settings);
  check("remove reports changed", r1.changed === true);
  check(
    "remove keeps the user's own SessionStart hook",
    r1.settings.hooks.SessionStart.some((g) =>
      g.hooks?.some((h) => h.command === "echo my-own-hook"),
    ),
  );
  check(
    "remove prunes an event that only had a Conan group (Stop gone)",
    r1.settings.hooks.Stop === undefined,
  );

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  // install-global is token-gated.
  const noAuth = await fetch(`${BASE}/api/claude/hooks/install-global`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("POST install-global without token is 401", noAuth.status === 401);

  // Seed a pre-existing user settings file the install must preserve.
  fs.mkdirSync(path.dirname(globalSettings), { recursive: true });
  fs.writeFileSync(
    globalSettings,
    JSON.stringify({ statusLine: { type: "command" }, hooks: {} }, null, 2),
  );

  const inst = await (
    await fetch(`${BASE}/api/claude/hooks/install-global`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: "{}",
    })
  ).json();
  check("install-global reports changed + path", inst.ok && inst.changed && inst.path === globalSettings);

  const written = JSON.parse(fs.readFileSync(globalSettings, "utf8"));
  check("installed file preserves the unknown statusLine key", written.statusLine?.type === "command");
  check(
    "installed file wires the Conan Stop hook with an absolute command",
    written.hooks.Stop.some((g) =>
      g.hooks?.some((h) => h.command.includes(hooks.SEND_EVENT_SCRIPT) && path.isAbsolute(hooks.SEND_EVENT_SCRIPT)),
    ),
  );
  check("install backed up the prior settings file", fs.existsSync(globalSettings + ".conan-bak"));

  // Re-install is a no-op.
  const inst2 = await (
    await fetch(`${BASE}/api/claude/hooks/install-global`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: "{}",
    })
  ).json();
  check("re-install is a no-op (changed=false)", inst2.ok && inst2.changed === false);

  // --- cwd-aware ingestion + filtering ------------------------------------
  const cwdA = "/tmp/project-alpha";
  const cwdB = "/tmp/project-beta";
  const post = (session_id, cwd) =>
    fetch(`${BASE}/api/claude/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: JSON.stringify({ session_id, cwd, hook_event_name: "UserPromptSubmit", payload: {} }),
    });
  await post("sess-A", cwdA);
  await post("sess-A2", cwdA);
  await post("sess-B", cwdB);
  await sleep(100);

  const all = await (await fetch(`${BASE}/api/claude/events`)).json();
  check("ingests events from arbitrary cwds (not just this repo)", all.length >= 3);

  const onlyA = await (
    await fetch(`${BASE}/api/claude/events?cwd=${encodeURIComponent(cwdA)}`)
  ).json();
  check("GET /api/claude/events?cwd= filters to that cwd", onlyA.length === 2);
  check(
    "filtered events all belong to cwd A's sessions",
    onlyA.every((e) => e.session_id === "sess-A" || e.session_id === "sess-A2"),
  );

  const onlyB = await (
    await fetch(`${BASE}/api/claude/events?cwd=${encodeURIComponent(cwdB)}`)
  ).json();
  check("cwd B filter returns only its event", onlyB.length === 1 && onlyB[0].session_id === "sess-B");

  // Session rows persisted the cwd (queryable by cwd).
  const sessions = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  check(
    "session rows store the originating cwd",
    sessions.find((s) => s.id === "sess-B")?.cwd === cwdB,
  );
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
