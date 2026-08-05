import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import {
  callReadBrowser,
  closeBrowserToolSession,
  handleMcpMessage,
  hasBrowserToolSession,
  mcpConfigFor,
  openBrowserToolSession,
  resetBrowserToolSessions,
} from "./mcp.js";
import type { BrowserSurfaceState } from "./surface.js";

function surface(over: Partial<BrowserSurfaceState> = {}): BrowserSurfaceState {
  return {
    url: "http://127.0.0.1:1/",
    active: true,
    title: "A page",
    problem: null,
    loading: false,
    ...over,
  };
}

/** The text of a tool result, for readability in assertions. */
function body(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function serve(html: string, headers: Record<string, string> = { "content-type": "text/html" }) {
  return new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, headers);
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

test("sessions are keyed, unguessable, and removable", () => {
  resetBrowserToolSessions();
  const a = openBrowserToolSession(() => surface());
  const b = openBrowserToolSession(() => surface());
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, "key should not be short enough to guess");
  assert.ok(hasBrowserToolSession(a));
  closeBrowserToolSession(a);
  assert.equal(hasBrowserToolSession(a), false);
  // Closing one session must not disturb another live conversation.
  assert.ok(hasBrowserToolSession(b));
  resetBrowserToolSessions();
});

test("the tool reads state live, not as a snapshot from launch", async () => {
  resetBrowserToolSessions();
  let current = surface({ url: "http://first.test/", title: "First" });
  const key = openBrowserToolSession(() => current);
  current = surface({ url: "http://second.test/", title: "Second" });
  const response = await handleMcpMessage(key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_browser", arguments: { scope: "metadata" } },
  });
  assert.match(body(response!.result as never), /second\.test/);
  resetBrowserToolSessions();
});

test("initialize and tools/list advertise read_browser with its four scopes", async () => {
  resetBrowserToolSessions();
  const key = openBrowserToolSession(() => surface());
  const init = await handleMcpMessage(key, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal((init!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");

  const list = await handleMcpMessage(key, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (list!.result as { tools: Array<{ name: string; inputSchema: never }> }).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "read_browser");
  const schema = tools[0]!.inputSchema as unknown as {
    properties: { scope: { enum: string[] } };
    required: string[];
  };
  assert.deepEqual(schema.properties.scope.enum, [
    "metadata",
    "selection",
    "fullText",
    "screenshot",
  ]);
  assert.deepEqual(schema.required, ["scope"]);
  resetBrowserToolSessions();
});

test("notifications get no reply; unknown methods get -32601, not a throw", async () => {
  resetBrowserToolSessions();
  const key = openBrowserToolSession(() => surface());
  assert.equal(await handleMcpMessage(key, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const unknown = await handleMcpMessage(key, { jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(unknown!.error?.code, -32601);
  resetBrowserToolSessions();
});

test("a call against a closed session explains itself instead of erroring out", async () => {
  resetBrowserToolSessions();
  const key = openBrowserToolSession(() => surface());
  closeBrowserToolSession(key);
  const response = await handleMcpMessage(key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_browser", arguments: { scope: "metadata" } },
  });
  assert.match(body(response!.result as never), /no longer connected/);
  assert.equal((response!.result as { isError: boolean }).isError, true);
});

test("an invalid scope is a tool error the model can recover from", async () => {
  resetBrowserToolSessions();
  const key = openBrowserToolSession(() => surface());
  for (const scope of ["html", "", 7, undefined]) {
    const response = await handleMcpMessage(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_browser", arguments: { scope } },
    });
    const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true, `scope ${JSON.stringify(scope)} should be refused`);
    // The message must list the valid scopes so the model can retry correctly.
    assert.match(body(result), /metadata, selection, fullText, screenshot/);
  }
  resetBrowserToolSessions();
});

test("selection and screenshot refuse with the reason, not a bare 'unsupported'", async () => {
  for (const scope of ["selection", "screenshot"] as const) {
    const result = await callReadBrowser(scope, surface());
    assert.equal(result.isError, true);
    assert.match(body(result), /same-origin policy/);
    // The model must be told this is not a permission it can ask for.
    assert.match(body(result), /enforced by the browser/);
  }
  // ...and each points somewhere useful rather than dead-ending.
  assert.match(body(await callReadBrowser("selection", surface())), /ask the user to paste/);
  assert.match(body(await callReadBrowser("screenshot", surface())), /fullText/);
});

test("an empty or broken surface is reported honestly", async () => {
  const empty = await callReadBrowser("fullText", surface({ url: null }));
  assert.equal(empty.isError, true);
  assert.match(body(empty), /no page open/);

  const broken = await callReadBrowser("fullText", surface({ problem: "X-Frame-Options: DENY" }));
  assert.equal(broken.isError, true);
  assert.match(body(broken), /did not load/);
  assert.match(body(broken), /do not describe its contents/i);
});

test("fullText returns the page and warns when it is only a client-rendered shell", async () => {
  const { server, url } = await serve(
    '<html><head><title>Vite App</title></head><body><div id="root"></div><script src="/m.js"></script></body></html>',
  );
  try {
    const result = await callReadBrowser("fullText", surface({ url, title: "Vite App" }));
    assert.equal(result.isError, undefined);
    // The warning is the whole point: without it the model reports a blank page.
    assert.match(body(result), /renders client-side/);
    assert.match(body(result), /NOT what the user sees/);
  } finally {
    server.close();
  }
});

test("fullText on a server-rendered page carries the text and no false warning", async () => {
  const { server, url } = await serve(
    "<html><head><title>Docs</title></head><body><h1>Install</h1><p>Run npm install.</p></body></html>",
  );
  try {
    const result = await callReadBrowser("fullText", surface({ url, title: "Docs" }));
    assert.match(body(result), /Install\nRun npm install\./);
    assert.doesNotMatch(body(result), /renders client-side/);
  } finally {
    server.close();
  }
});

test("metadata falls back to a fresh fetch when the surface never got a title", async () => {
  const { server, url } = await serve("<html><head><title>Late Title</title></head><body>x</body></html>");
  try {
    const result = await callReadBrowser("metadata", surface({ url, title: null }));
    assert.match(body(result), /Late Title/);
  } finally {
    server.close();
  }
});

test("mcpConfigFor points at the session's own keyed endpoint on the right port", () => {
  const config = JSON.parse(mcpConfigFor(3850, "abc123")) as {
    mcpServers: { conan: { type: string; url: string } };
  };
  assert.equal(config.mcpServers.conan.type, "http");
  assert.equal(config.mcpServers.conan.url, "http://127.0.0.1:3850/mcp/abc123");
});

test("a call landing mid-probe answers, but flags that it is not yet the user's screen", async () => {
  const { server, url } = await serve(
    "<html><head><title>Docs</title></head><body><p>Install it.</p></body></html>",
  );
  try {
    const loading = await callReadBrowser("fullText", surface({ url, title: null, loading: true }));
    assert.equal(loading.isError, undefined, "a probe in flight must not block the read");
    assert.match(body(loading), /Install it\./);
    assert.match(body(loading), /still loading this URL/);
    assert.match(body(loading), /may not see this content yet/);

    // ...and says nothing of the sort once the surface has settled.
    const settled = await callReadBrowser("fullText", surface({ url, title: null }));
    assert.doesNotMatch(body(settled), /still loading/);
  } finally {
    server.close();
  }
});

test("metadata carries the same mid-probe caveat", async () => {
  const { server, url } = await serve("<html><head><title>Docs</title></head><body>x</body></html>");
  try {
    const result = await callReadBrowser("metadata", surface({ url, title: "Docs", loading: true }));
    assert.match(body(result), /still loading this URL/);
  } finally {
    server.close();
  }
});
