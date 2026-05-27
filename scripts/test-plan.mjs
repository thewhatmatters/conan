// US-003 test: the pure plan-state reducer (src/plan/index.ts). Reduces a
// session's hook event stream into latest-wins TodoWrite todos + the last
// ExitPlanMode plan, and decides source/isActive under the documented
// precedence. No DB / clock of its own — events + opts are injected.
//
// Run: tsx scripts/test-plan.mjs

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

// Build an EventRow-like object the reducer accepts (only the fields it reads).
let nextId = 1;
const ev = (tool_name, toolInput, ts) => ({
  id: nextId++,
  session_id: "s",
  parent_tool_use_id: null,
  hook_event_name: "PostToolUse",
  stream_type: "hook",
  tool_name,
  payload: JSON.stringify({ tool_name, tool_input: toolInput }),
  ts,
});
const todoEv = (todos, ts) => ev("TodoWrite", { todos }, ts);
const planEv = (plan, ts) => ev("ExitPlanMode", { plan }, ts);
const todo = (content, status) => ({ content, status, activeForm: `Doing ${content}` });

try {
  const { reducePlanState } = await import("../src/plan/index.ts");
  const NOW = 1_700_000_000_000; // realistic epoch-ms clock

  // --- empty / no signal --------------------------------------------------
  const empty = reducePlanState([], { now: NOW });
  check("no events -> none, inactive", empty.source === "none" && empty.isActive === false);
  check("no events -> empty todos, null plan", empty.todos.length === 0 && empty.proposedPlan === null);

  // --- TodoWrite latest-wins ----------------------------------------------
  const r1 = reducePlanState(
    [
      todoEv([todo("a", "pending")], NOW - 5000),
      todoEv([todo("a", "completed"), todo("b", "in_progress")], NOW - 1000),
    ],
    { now: NOW },
  );
  check("latest TodoWrite wins (2 items)", r1.todos.length === 2);
  check("latest TodoWrite -> source todos", r1.source === "todos");
  check("open item -> active", r1.isActive === true);
  check("todo fields preserved", r1.todos[1].content === "b" && r1.todos[1].status === "in_progress" && r1.todos[1].activeForm === "Doing b");

  // --- all-completed TodoWrite hides (US-004) -----------------------------
  const r2 = reducePlanState(
    [planEv("# Plan\ndo things", NOW - 2000), todoEv([todo("a", "completed"), todo("b", "completed")], NOW - 1000)],
    { now: NOW },
  );
  check("all-completed todos -> inactive (even with a plan present)", r2.isActive === false);
  check("all-completed -> source still todos (dominant)", r2.source === "todos");

  // --- empty TodoWrite list is a real (seen) list -------------------------
  const r3 = reducePlanState([todoEv([], NOW - 1000)], { now: NOW });
  check("empty TodoWrite list seen -> source todos, inactive", r3.source === "todos" && r3.isActive === false);

  // --- ExitPlanMode plan, no todos ----------------------------------------
  const r4 = reducePlanState([planEv("# Plan A", NOW - 5000), planEv("# Plan B", NOW - 1000)], { now: NOW });
  check("latest plan wins", r4.proposedPlan === "# Plan B");
  check("recent plan, no todos -> source plan, active", r4.source === "plan" && r4.isActive === true);

  // --- stale plan ---------------------------------------------------------
  const r5 = reducePlanState([planEv("# Old", NOW - 60 * 60_000)], { now: NOW });
  check("stale plan (past max age) -> inactive, none", r5.isActive === false && r5.source === "none");
  check("stale plan markdown still returned for display", r5.proposedPlan === "# Old");

  // --- build-loop fallback ------------------------------------------------
  const r6 = reducePlanState([], { now: NOW, buildLoopActive: true });
  check("no plan but build loop active -> source build-loop, active", r6.source === "build-loop" && r6.isActive === true);
  const r7 = reducePlanState([todoEv([todo("a", "completed")], NOW - 1000)], { now: NOW, buildLoopActive: true });
  check("completed todos take precedence over build loop -> inactive", r7.isActive === false && r7.source === "todos");

  // --- malformed payloads are ignored, not crashing -----------------------
  const bad = { id: nextId++, session_id: "s", tool_name: "TodoWrite", payload: "{not json", ts: NOW };
  const r8 = reducePlanState([bad, todoEv([todo("a", "pending")], NOW)], { now: NOW });
  check("malformed payload skipped; good one still reduces", r8.todos.length === 1 && r8.isActive === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
