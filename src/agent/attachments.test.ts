import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PIN_BYTES,
  prepareFileAttachments,
  serializeTurnPrompt,
} from "./attachments.js";

test("plain prompts and unpinned @ paths are unchanged", () => {
  const text = "Review @src/agent/driver.ts";
  assert.equal(serializeTurnPrompt({ text, attachments: [], images: [] }), text);
});

test("image turns carry both inline bytes and a staged path without changing prompt text", () => {
  const image = {
    type: "image" as const,
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
    bytes: 8,
    stagedPath: "/tmp/conan-images/example.png",
  };
  assert.equal(
    serializeTurnPrompt({ text: "Describe it", attachments: [], images: [image] }),
    "Describe it",
  );
});

test("a structured pin serializes path and exact content in a delimited block", () => {
  const [pin] = prepareFileAttachments([
    { type: "file", path: "notes/a.md", content: "private context" },
  ]);
  assert.ok(pin);
  assert.equal(pin.content, "private context");
  assert.equal(pin.truncated, false);
  const prompt = serializeTurnPrompt({ text: "Summarize it", attachments: [pin] });
  assert.match(prompt, /--- BEGIN PINNED FILE 1 ---/);
  assert.match(prompt, /Path: "notes\/a\.md"/);
  assert.match(prompt, /Status: complete: 15 UTF-8 bytes/);
  assert.match(prompt, /private context/);
  assert.match(prompt, /--- END PINNED FILE 1 ---/);
});

test("oversized pins are bounded and carry an honest visible marker", () => {
  const [pin] = prepareFileAttachments([
    { type: "file", path: "large.txt", content: "x".repeat(MAX_PIN_BYTES + 50) },
  ]);
  assert.ok(pin);
  assert.equal(pin.truncated, true);
  assert.equal(pin.sentBytes, MAX_PIN_BYTES);
  assert.equal(pin.originalBytes, MAX_PIN_BYTES + 50);
  const prompt = serializeTurnPrompt({ text: "Read", attachments: [pin] });
  assert.match(prompt, /TRUNCATED: sent 32768 of 32818/);
});

test("pins are per-turn data and keep is only retained when explicit", () => {
  const pins = prepareFileAttachments([
    { type: "file", path: "one", content: "1" },
    { type: "file", path: "two", content: "2", keep: true },
  ]);
  assert.equal(pins[0]?.keep, undefined);
  assert.equal(pins[1]?.keep, true);
  assert.deepEqual(prepareFileAttachments(undefined), []);
});

test("the aggregate guard marks later pins instead of silently dropping them", () => {
  const pins = prepareFileAttachments([
    { type: "file", path: "one", content: "a".repeat(MAX_PIN_BYTES) },
    { type: "file", path: "two", content: "b".repeat(MAX_PIN_BYTES) },
    { type: "file", path: "three", content: "still represented" },
  ]);
  assert.equal(pins.length, 3);
  assert.equal(pins[2]?.content, "");
  assert.equal(pins[2]?.truncated, true);
  assert.match(
    serializeTurnPrompt({ text: "Read", attachments: pins }),
    /TRUNCATED: sent 0 of 17 UTF-8 bytes/,
  );
});
