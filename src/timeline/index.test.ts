// parseTouchedFiles() powers the File Explorer's "Claude touched this" badges:
// it reduces a session's Edit/Write/Read hook events to file-path sets, with
// edited (Edit/Write) outranking read (Read) for the same path. Pure, so it's
// unit-tested directly with synthetic event rows. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTouchedFiles } from "./index.js";

/** A persisted-event row as the gateway query hands it to the parser. */
function row(tool: string, filePath?: string, raw?: string) {
  return {
    tool_name: tool,
    payload: raw ?? JSON.stringify({ tool_input: { file_path: filePath } }),
  };
}

test("splits edited (Edit/Write) from read (Read) by file_path", () => {
  const { edited, read } = parseTouchedFiles([
    row("Edit", "/p/a.ts"),
    row("Write", "/p/b.ts"),
    row("Read", "/p/c.ts"),
  ]);
  assert.deepEqual(edited.sort(), ["/p/a.ts", "/p/b.ts"]);
  assert.deepEqual(read, ["/p/c.ts"]);
});

test("a path both read and edited counts only as edited", () => {
  const { edited, read } = parseTouchedFiles([
    row("Read", "/p/a.ts"),
    row("Edit", "/p/a.ts"),
  ]);
  assert.deepEqual(edited, ["/p/a.ts"]);
  assert.deepEqual(read, []);
});

test("dedups repeated touches of the same path", () => {
  const { edited } = parseTouchedFiles([
    row("Edit", "/p/a.ts"),
    row("Edit", "/p/a.ts"),
  ]);
  assert.deepEqual(edited, ["/p/a.ts"]);
});

test("skips rows with malformed payloads or no file_path", () => {
  const { edited, read } = parseTouchedFiles([
    row("Edit", undefined, "not json{"),
    row("Read", undefined, JSON.stringify({ tool_input: {} })),
    { tool_name: "Edit", payload: null },
    row("Edit", "/p/ok.ts"),
  ]);
  assert.deepEqual(edited, ["/p/ok.ts"]);
  assert.deepEqual(read, []);
});
