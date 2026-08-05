import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  browserContextBlock,
  EMPTY_SURFACE,
  parseSurfaceFrame,
  withBrowserContext,
} from "./surface.js";

test("parseSurfaceFrame: accepts a well-formed frame and normalizes the URL", () => {
  const state = parseSurfaceFrame({
    url: "http://localhost:5173",
    active: true,
    title: "  Vite App  ",
  });
  assert.deepEqual(state, {
    url: "http://localhost:5173/",
    active: true,
    title: "Vite App",
    problem: null,
  });
});

test("parseSurfaceFrame: an empty URL is a valid empty surface, not a rejection", () => {
  assert.deepEqual(parseSurfaceFrame({ url: "", active: true }), {
    url: null,
    active: true,
    title: null,
    problem: null,
  });
});

test("parseSurfaceFrame: rejects non-http schemes and junk", () => {
  // file:/data: must not ride this channel into the model's context.
  assert.equal(parseSurfaceFrame({ url: "file:///etc/passwd", active: true }), null);
  assert.equal(parseSurfaceFrame({ url: "data:text/html,<b>x</b>", active: true }), null);
  assert.equal(parseSurfaceFrame({ url: "javascript:alert(1)", active: true }), null);
  assert.equal(parseSurfaceFrame({ url: "not a url", active: true }), null);
  assert.equal(parseSurfaceFrame(null), null);
  assert.equal(parseSurfaceFrame("nope"), null);
});

test("parseSurfaceFrame: active defaults to false unless strictly true", () => {
  assert.equal(parseSurfaceFrame({ url: "http://a.test/", active: "yes" })?.active, false);
  assert.equal(parseSurfaceFrame({ url: "http://a.test/" })?.active, false);
});

test("browserContextBlock: silent unless the surface is active with a URL", () => {
  assert.equal(browserContextBlock(EMPTY_SURFACE), null);
  assert.equal(
    browserContextBlock({ url: "http://a.test/", active: false, title: "A", problem: null }),
    null,
  );
  assert.equal(browserContextBlock({ url: null, active: true, title: null, problem: null }), null);
});

test("browserContextBlock: names the page and says the text was withheld", () => {
  const block = browserContextBlock({
    url: "http://localhost:5173/",
    active: true,
    title: "Dashboard",
    problem: null,
  })!;
  assert.match(block, /Active browser surface: Dashboard — http:\/\/localhost:5173\//);
  // The ticket is explicit that page text is never auto-sent; the block must
  // point at the tool instead of implying the model already has the content.
  assert.match(block, /mcp__conan__read_browser/);
});

test("browserContextBlock: a failed page is reported as failed, not described", () => {
  const block = browserContextBlock({
    url: "https://github.com/",
    active: true,
    title: null,
    problem: "X-Frame-Options: DENY forbids embedding",
  })!;
  assert.match(block, /did not load/);
  assert.match(block, /Do not describe its contents/);
  assert.doesNotMatch(block, /read_browser/);
});

test("browserContextBlock: a hostile title cannot flood the prompt", () => {
  const block = browserContextBlock({
    url: "http://a.test/",
    active: true,
    title: "x".repeat(5_000),
    problem: null,
  })!;
  assert.ok(block.length < 500);
  assert.match(block, /…/);
});

test("withBrowserContext: prepends when active, passes through untouched otherwise", () => {
  const active = { url: "http://a.test/", active: true, title: "A", problem: null };
  assert.match(withBrowserContext("what is this?", active), /^Active browser surface: A/);
  assert.match(withBrowserContext("what is this?", active), /what is this\?$/);
  assert.equal(withBrowserContext("unchanged", EMPTY_SURFACE), "unchanged");
});
