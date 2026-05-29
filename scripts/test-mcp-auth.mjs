// US-011 test: the MCP auth driver's pure navigation/parse helpers, exercised
// against the real /mcp TUI frames captured by the US-010 spike
// (scripts/fixtures/mcp-tui/). The live throwaway-pty driver itself needs a real
// logged-in claude (like probeUsage), so here we only assert it degrades safely
// when disabled — and never spawns / throws.
//
// Run: tsx scripts/test-mcp-auth.mjs
import fs from "node:fs";

// No real `claude` pty during tests.
process.env.CONAN_DISABLE_MCP_AUTH = "1";
process.env.CONAN_DISABLE_USAGE_PROBE = "1";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

const fx = (name) =>
  fs.readFileSync(new URL(`./fixtures/mcp-tui/${name}`, import.meta.url), "utf8");

try {
  const auth = await import("../src/mcp/auth.ts");

  // --- parseHighlightedServer: name after the last ❯ in a ↓ redraw delta -----
  check(
    "down-delta -> 'paper'",
    auth.parseHighlightedServer(fx("frame-01-down.txt")) === "paper",
  );
  check(
    "down-delta -> 'claude.ai Figma'",
    auth.parseHighlightedServer(fx("frame-02-down.txt")) === "claude.ai Figma",
  );
  check(
    "down-delta -> 'claude.ai Gmail'",
    auth.parseHighlightedServer(fx("frame-03-down.txt")) === "claude.ai Gmail",
  );
  check(
    "down-delta -> 'claude.ai Google Calendar'",
    auth.parseHighlightedServer(fx("frame-04-down.txt")) ===
      "claude.ai Google Calendar",
  );
  check(
    "down-delta -> 'claude.ai Google Drive'",
    auth.parseHighlightedServer(fx("frame-05-down.txt")) ===
      "claude.ai Google Drive",
  );
  check(
    "no cursor row -> null",
    auth.parseHighlightedServer("just some output, no cursor") === null,
  );

  // --- serversMatch: tolerant of the TUI's glued vs spaced names -------------
  check(
    "glued list name matches spaced mcp-list name",
    auth.serversMatch("claude.aiGoogleDrive", "claude.ai Google Drive") === true,
  );
  check(
    "exact match",
    auth.serversMatch("paper", "paper") === true,
  );
  check(
    "different servers don't match",
    auth.serversMatch("claude.ai Gmail", "claude.ai Google Drive") === false,
  );

  // --- parseServerCount ------------------------------------------------------
  check("server count = 7 from the list frame", auth.parseServerCount(fx("frame-00-mcp-open.txt")) === 7);
  check("server count null when absent", auth.parseServerCount("no count here") === null);

  // --- parseDetailActions + findActionOffset, per status -------------------
  // needs-authentication (Google Drive): [Authenticate, Disable]
  const needsAuth = auth.parseDetailActions(fx("frame-06-enter.txt"));
  check("needs-auth: 2 actions", needsAuth.length === 2);
  check("needs-auth: labels", JSON.stringify(needsAuth.map((a) => a.label)) === '["Authenticate","Disable"]');
  check("needs-auth: Authenticate offset 0", auth.findActionOffset(needsAuth, "Authenticate") === 0);
  check("needs-auth: no Reconnect", auth.findActionOffset(needsAuth, "Reconnect") === null);

  // failed (paper): [Authenticate, Reconnect, Disable]
  const failedActions = auth.parseDetailActions(fx("frame-02-enter.txt"));
  check("failed: 3 actions", failedActions.length === 3);
  check("failed: labels", JSON.stringify(failedActions.map((a) => a.label)) === '["Authenticate","Reconnect","Disable"]');
  check("failed: Authenticate offset 0", auth.findActionOffset(failedActions, "Authenticate") === 0);
  check("failed: Reconnect offset 1", auth.findActionOffset(failedActions, "Reconnect") === 1);

  // connected (refero): [View tools, Re-authenticate, Cl(e)ar authentication, Reconnect, Disable]
  const connected = auth.parseDetailActions(fx("frame-01-enter.txt"));
  check("connected: 5 actions", connected.length === 5);
  check("connected: Reconnect offset 3", auth.findActionOffset(connected, "Reconnect") === 3);
  check(
    "connected: 'Authenticate' does NOT match 'Re-authenticate'",
    auth.findActionOffset(connected, "Authenticate") === null,
  );

  // An IP/URL in the detail body must not be misread as a numbered action.
  check(
    "failed detail: no IP-octet ('127.', '0.') misparsed as an action",
    !failedActions.some((a) => /^\d*$/.test(a.label)) && failedActions.length === 3,
  );

  // --- sentinels -------------------------------------------------------------
  check("isListReady true on the list frame", auth.isListReady(fx("frame-00-mcp-open.txt")) === true);
  check("isListReady false on garbage", auth.isListReady("$ ls\nfoo bar") === false);
  check("isDetailReady true on a detail frame", auth.isDetailReady(fx("frame-06-enter.txt")) === true);
  check("isDetailReady false on the list frame", auth.isDetailReady("refero · connected") === false);
  check("isPendingFrame true on the post-auth frame", auth.isPendingFrame(fx("frame-07-enter.txt")) === true);
  check("isPendingFrame false on a detail frame", auth.isPendingFrame(fx("frame-06-enter.txt")) === false);

  // --- driver degrades safely when disabled (no spawn, no throw) -------------
  const disabled = await auth.driveMcpAuth("claude.ai Google Drive");
  check("disabled driver never throws + returns a result", !!disabled && disabled.ok === false);
  check("disabled driver reports the reason", /disabled/i.test(disabled.error ?? ""));
  check("disabled driver echoes the server name", disabled.server === "claude.ai Google Drive");
  check("disabled driver fired no action", disabled.action === null && disabled.pending === false);

  // --- US-012: pollMcpAuthCompletion (injectable lister, no real claude) ------
  const srv = (name, status) => ({ name, status, url: null, transport: null, statusText: status });
  const listResult = (servers) => ({ servers, error: null, at: 0 });

  // flip-to-connected: stays needs-authentication, then flips on the 3rd poll.
  {
    let calls = 0;
    const list = async (force) => {
      calls++;
      check(`poll forces a cache-bypass list (call ${calls})`, force === true);
      const status = calls >= 3 ? "connected" : "needs-authentication";
      return listResult([srv("claude.ai Google Drive", status)]);
    };
    const res = await auth.pollMcpAuthCompletion("claude.ai Google Drive", {
      intervalMs: 5,
      timeoutMs: 4_000,
      list,
    });
    check("flip: status connected", res.status === "connected");
    check("flip: lastStatus connected", res.lastStatus === "connected");
    check("flip: polled exactly until the flip (3)", res.polls === 3);
    check("flip: server echoed", res.server === "claude.ai Google Drive");
    // name match is whitespace-tolerant (glued TUI name vs spaced list name).
    const glued = await auth.pollMcpAuthCompletion("claude.aiGoogleDrive", {
      intervalMs: 5,
      timeoutMs: 4_000,
      list: async () => listResult([srv("claude.ai Google Drive", "connected")]),
    });
    check("flip: glued name matches spaced server", glued.status === "connected");
  }

  // timeout: never connects -> bounded timeout, status 'timeout', last status kept.
  {
    const t0 = Date.now();
    const res = await auth.pollMcpAuthCompletion("paper", {
      intervalMs: 5,
      timeoutMs: 80,
      list: async () => listResult([srv("paper", "failed")]),
    });
    const elapsed = Date.now() - t0;
    check("timeout: status timeout", res.status === "timeout");
    check("timeout: lastStatus kept (failed)", res.lastStatus === "failed");
    check("timeout: bounded by timeoutMs (no overrun)", elapsed < 2_000);
    check("timeout: issued at least one poll", res.polls >= 1);
  }

  // missing server: never appears -> timeout with null lastStatus, no crash.
  {
    const res = await auth.pollMcpAuthCompletion("ghost", {
      intervalMs: 5,
      timeoutMs: 60,
      list: async () => listResult([srv("paper", "failed")]),
    });
    check("missing: status timeout", res.status === "timeout");
    check("missing: lastStatus null", res.lastStatus === null);
  }

  // failed list call is non-fatal: swallowed + retried, then flips to connected.
  {
    let calls = 0;
    const res = await auth.pollMcpAuthCompletion("paper", {
      intervalMs: 5,
      timeoutMs: 4_000,
      list: async () => {
        calls++;
        if (calls < 2) throw new Error("list dial failed");
        return listResult([srv("paper", "connected")]);
      },
    });
    check("resilient: a thrown list poll is retried, then connects", res.status === "connected");
  }

  // abort: a pre-aborted signal returns timeout promptly without leaking timers.
  {
    const ac = new AbortController();
    ac.abort();
    const res = await auth.pollMcpAuthCompletion("paper", {
      intervalMs: 5,
      timeoutMs: 4_000,
      signal: ac.signal,
      list: async () => listResult([srv("paper", "failed")]),
    });
    check("abort: pre-aborted signal -> timeout", res.status === "timeout");
    check("abort: no polling after abort", res.polls === 0);
  }
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
