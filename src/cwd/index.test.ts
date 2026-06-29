// listEntries() backs the File Explorer panel: unlike listDirs (dirs-only, for
// the toolbar picker) it returns files AND directories, keeps dotfiles, sorts
// directories first then case-insensitively by name, and degrades unreadable
// targets to an empty listing with an `error` rather than throwing. Run with
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listEntries } from "./index.js";

/** Build a throwaway directory tree and return its root path. */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conan-fs-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".hidden-dir"));
  fs.writeFileSync(path.join(root, "zeta.txt"), "z");
  fs.writeFileSync(path.join(root, "alpha.ts"), "a");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {}");
  return root;
}

test("lists files AND directories, directories first then name-sorted", () => {
  const root = makeTree();
  const listing = listEntries(root);
  assert.equal(listing.error, undefined);
  const names = listing.entries.map((e) => e.name);
  // Dirs first (.hidden-dir, src — themselves name-sorted), then files
  // (.env, alpha.ts, zeta.txt — name-sorted). Dotfiles are kept.
  assert.deepEqual(names, [".hidden-dir", "src", ".env", "alpha.ts", "zeta.txt"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("entries carry isDir + a size for files", () => {
  const root = makeTree();
  const listing = listEntries(root);
  const src = listing.entries.find((e) => e.name === "src");
  const alpha = listing.entries.find((e) => e.name === "alpha.ts");
  assert.equal(src?.isDir, true);
  assert.equal(alpha?.isDir, false);
  assert.ok((alpha?.size ?? 0) > 0, "a non-empty file reports a positive size");
  assert.ok(alpha?.path.endsWith("/alpha.ts"), "entry path is absolute");
  fs.rmSync(root, { recursive: true, force: true });
});

test("parent is the containing dir, null only at the fs root", () => {
  const root = makeTree();
  const listing = listEntries(root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listEntries("/").parent, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unreadable target degrades to an empty listing with an error", () => {
  const listing = listEntries("/no/such/conan/dir/" + Date.now());
  assert.deepEqual(listing.entries, []);
  assert.match(listing.error ?? "", /cannot read/);
});
