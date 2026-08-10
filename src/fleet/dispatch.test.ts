// WHA-129 AC1/AC2 + the verifier's non-regression table: the dispatch seam
// writes exactly one attempt row per spawn, writes none for a connection that
// never prompts, keeps working for an ordinary unattributed chat turn, and
// stamps every attempt closed on teardown.
//
// Runs against a throwaway SQLite file — env is pointed at a temp dir BEFORE
// the db module (which captures paths at import) is loaded, same idiom as
// src/agent/threads.test.ts. Zero model calls. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver } from "../agent/driver.js";
import type { ProviderEntry } from "../agent/registry.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-dispatch-test-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = path.join(dataDir, "conan.db");

const { getDb } = await import("../db/index.js");
const { createDispatcher, disposeAllDispatched } = await import("./dispatch.js");

/** Count of `createDriver` calls, so "one attempt row" can be distinguished
 *  from "one row but two processes". */
let spawns = 0;
let disposals = 0;

function stubDriver(): AgentDriver {
  return {
    provider: "claude",
    capabilities: {} as AgentDriver["capabilities"],
    send: async () => {},
    interrupt: () => {},
    respondPermission: () => {},
    setPermissionMode: () => {},
    dispose: () => {
      disposals += 1;
    },
  };
}

function stubProvider(id: string): ProviderEntry {
  return {
    id,
    createDriver: () => {
      spawns += 1;
      return stubDriver();
    },
  } as unknown as ProviderEntry;
}

function rows(): Array<Record<string, unknown>> {
  return getDb()
    .prepare("SELECT * FROM attempt ORDER BY started_at")
    .all() as Array<Record<string, unknown>>;
}

function newDispatcher(context: "chat" | "fleet-attempt" = "chat") {
  return createDispatcher({
    context,
    emit: () => {},
    fallbackCwd: () => null,
  });
}

test("a connection that never prompts writes no attempt row", () => {
  const before = rows().length;
  const d = newDispatcher();
  // Socket opened and closed without a prompt — the driver is built lazily at
  // the first prompt, so there is nothing to record. A row here would be a
  // phantom session inflating every future provider comparison.
  d.dispose();
  assert.equal(rows().length, before);
  assert.equal(d.current(), null);
});

test("two racing prompts produce exactly one attempt row and one process", async () => {
  const before = rows().length;
  spawns = 0;
  const d = newDispatcher();
  const plan = async () => {
    // Resolving a provider is async (an install probe); the race window is
    // real, which is why the gate lives inside the seam.
    await new Promise((r) => setTimeout(r, 10));
    return {
      provider: stubProvider("claude"),
      model: null,
      permissionMode: "default",
      cwd: "/tmp/p",
    };
  };
  const [a, b] = await Promise.all([d.spawn(plan), d.spawn(plan)]);

  assert.equal(spawns, 1, "createDriver ran more than once");
  assert.equal(a.driver, b.driver, "racing prompts got different drivers");
  const added = rows().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.provider, "claude");
  assert.equal(added[0]!.containment_observed, "prompt-gated");
  d.dispose();
});

test("an unattributed chat spawn succeeds — no ticket, no AC, no verifier", async () => {
  const before = rows().length;
  const d = newDispatcher("chat");
  const s = await d.spawn(async () => ({
    provider: stubProvider("kimi"),
    model: null,
    permissionMode: null,
    cwd: null,
  }));

  // The point of the DispatchContext discriminant: an ordinary interactive
  // turn carries none of the fleet metadata and must still spawn.
  assert.ok(s.driver, "chat spawn was refused");
  const row = rows().slice(before)[0]!;
  assert.equal(row.context, "chat");
  assert.equal(row.session_id, null, "session id is not known at spawn");
  assert.equal(row.containment_observed, "none");
  assert.equal(row.ended_at, null, "a live attempt must not be pre-closed");
  d.dispose();
});

test("the session id backfills at init and teardown stamps ended_at", async () => {
  const before = rows().length;
  disposals = 0;
  const d = newDispatcher();
  await d.spawn(async () => ({
    provider: stubProvider("codex"),
    model: "gpt-5.5",
    permissionMode: "read-only",
    cwd: "/tmp/p",
  }));
  d.bindSession("sess-42");
  d.recordCost(0.25);
  d.recordCost(0.75);
  d.dispose();
  d.dispose(); // idempotent — a socket close plus a shutdown sweep

  const row = rows().slice(before)[0]!;
  assert.equal(row.session_id, "sess-42");
  assert.equal(row.model, "gpt-5.5");
  assert.equal(row.containment_observed, "os-sandbox");
  assert.equal(row.cost_usd, 1, "per-turn costs must accumulate, not replace");
  assert.ok(typeof row.ended_at === "number", "ended_at was never stamped");
  assert.ok(typeof row.duration_ms === "number");
  assert.equal(disposals, 1, "dispose must not tear the process down twice");
});

test("a refused spawn clears the gate so the next prompt can retry", async () => {
  const before = rows().length;
  const d = newDispatcher();
  await assert.rejects(
    d.spawn(async () => {
      // What resolveRequestedProvider does for an unknown/uninstalled provider.
      throw new Error("unknown provider: nope");
    }),
    /unknown provider/,
  );
  // No process, so no attempt row — and critically the connection is still
  // usable, otherwise a typo in the provider chip hangs the composer forever.
  assert.equal(rows().length, before);

  const s = await d.spawn(async () => ({
    provider: stubProvider("grok"),
    model: null,
    permissionMode: null,
    cwd: null,
  }));
  assert.ok(s.driver, "retry after a refused spawn was blocked");
  assert.equal(rows().slice(before)[0]!.containment_observed, "fail-closed-cancel");
  d.dispose();
});

test("a socket closing mid-build spawns no process and records no row", async () => {
  // The regression Barkley and I caught at de77edd. `plan()` is the async
  // provider install probe, so it can hold for seconds; a user who closes the
  // tab inside that window used to get a real process spawned with no socket
  // attached and an attempt row whose `ended_at` was never stamped — and
  // because `dispose()` had already run, neither a later dispose nor the
  // shutdown sweep could reach it. An attempt that outlives its connection
  // makes every duration in the ledger a lie.
  const before = rows().length;
  spawns = 0;
  const d = newDispatcher();
  let release!: () => void;
  const probe = new Promise<void>((r) => {
    release = r;
  });
  const pending = d.spawn(async () => {
    await probe;
    return {
      provider: stubProvider("claude"),
      model: null,
      permissionMode: "default",
      cwd: null,
    };
  });

  d.dispose(); // socket closed while the probe is still in flight
  release();
  await assert.rejects(pending, /connection closed/);

  assert.equal(spawns, 0, "spawned a process for a connection already closed");
  assert.equal(rows().length, before, "wrote an attempt row for an aborted spawn");
  assert.equal(d.current(), null);
});

test("WHA-125 AC 2: an ordinary chat turn writes a row with NO lineage", async () => {
  // AC 2 is a claim about today's traffic, not about fleet runs: every
  // interactive turn is already in the ledger, with the columns that make it
  // comparable (cost, duration, containment) and none of the ones that would
  // make it claim a ticket. The type refuses `{ context: "chat", lineage }`;
  // this is the row-level half of the same statement.
  const before = rows().length;
  const d = newDispatcher("chat");
  await d.spawn(async () => ({
    provider: stubProvider("claude"),
    model: null,
    permissionMode: "default",
    cwd: null,
  }));
  d.bindSession("sess-chat-125");
  d.recordCost(0.1);
  d.dispose();

  const row = rows().slice(before)[0]!;
  assert.equal(row.context, "chat");
  for (const col of [
    "run_id",
    "ticket_id",
    "task_id",
    "role",
    "principal_id",
    "binding_id",
  ]) {
    assert.equal(row[col], null, `a chat turn claimed lineage in ${col}`);
  }
  assert.equal(row.cost_usd, 0.1, "cost where available (AC 2)");
  assert.equal(typeof row.duration_ms, "number", "duration where available (AC 2)");
  assert.equal(row.containment_observed, "prompt-gated");

  const bridge = getDb()
    .prepare("SELECT session_id FROM attempt_session WHERE attempt_id = ?")
    .all(row.id as string) as Array<{ session_id: string }>;
  assert.deepEqual(
    bridge.map((b) => b.session_id),
    ["sess-chat-125"],
    "the session bridge must record a chat session too",
  );
});

test("shutdown closes every live attempt", async () => {
  const before = rows().length;
  const a = newDispatcher();
  const b = newDispatcher();
  for (const d of [a, b]) {
    await d.spawn(async () => ({
      provider: stubProvider("claude"),
      model: null,
      permissionMode: "default",
      cwd: null,
    }));
  }
  disposeAllDispatched();

  const added = rows().slice(before);
  assert.equal(added.length, 2);
  for (const row of added) {
    assert.ok(typeof row.ended_at === "number", "shutdown left an attempt open");
  }
});
