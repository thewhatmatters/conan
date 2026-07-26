import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { decideFrameable, parseFrameAncestors, probeUrl } from "./probe.js";

const PAGE = "http://localhost:5199";

test("no headers → frameable", () => {
  assert.deepEqual(decideFrameable(null, null, "http://localhost:3000", PAGE), {
    frameable: true,
    reason: null,
  });
});

test("X-Frame-Options DENY → refused", () => {
  const d = decideFrameable("DENY", null, "https://github.com", PAGE);
  assert.equal(d.frameable, false);
  assert.match(d.reason!, /DENY/);
});

test("X-Frame-Options SAMEORIGIN → refused cross-origin, allowed same-origin", () => {
  assert.equal(decideFrameable("SAMEORIGIN", null, "https://github.com", PAGE).frameable, false);
  assert.equal(decideFrameable("SAMEORIGIN", null, PAGE, PAGE).frameable, true);
});

test("frame-ancestors 'none' → refused, and overrides a permissive XFO", () => {
  const d = decideFrameable(null, "'none'", "https://x.test", PAGE);
  assert.equal(d.frameable, false);
  assert.equal(decideFrameable("ALLOWALL", "'none'", "https://x.test", PAGE).frameable, false);
});

test("frame-ancestors * / 'self' / explicit origin", () => {
  assert.equal(decideFrameable(null, "*", "https://x.test", PAGE).frameable, true);
  assert.equal(decideFrameable(null, "'self'", PAGE, PAGE).frameable, true);
  assert.equal(decideFrameable(null, "'self'", "https://x.test", PAGE).frameable, false);
  assert.equal(decideFrameable(null, `'self' ${PAGE}`, "https://x.test", PAGE).frameable, true);
});

test("parseFrameAncestors extracts the directive from a full CSP", () => {
  assert.equal(
    parseFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *"),
    "'none'",
  );
  assert.equal(parseFrameAncestors("default-src 'self'"), null);
  assert.equal(parseFrameAncestors(null), null);
});

/** Serve one response with the given headers on an ephemeral port. */
function serve(headers: Record<string, string>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", ...headers });
      res.end("<html><body>ok</body></html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

test("probeUrl: plain local server → reachable + frameable", async () => {
  const { server, url } = await serve({});
  try {
    const p = await probeUrl(url, PAGE);
    assert.deepEqual(p, { reachable: true, frameable: true, reason: null, status: 200 });
  } finally {
    server.close();
  }
});

test("probeUrl: XFO DENY server → reachable but refused", async () => {
  const { server, url } = await serve({ "x-frame-options": "DENY" });
  try {
    const p = await probeUrl(url, PAGE);
    assert.equal(p.reachable, true);
    assert.equal(p.frameable, false);
    assert.match(p.reason!, /DENY/);
  } finally {
    server.close();
  }
});

test("probeUrl: dead port → unreachable, never throws", async () => {
  const p = await probeUrl("http://127.0.0.1:59999/", PAGE);
  assert.equal(p.reachable, false);
  assert.equal(p.frameable, false);
  assert.equal(p.status, null);
  assert.ok(p.reason);
});
