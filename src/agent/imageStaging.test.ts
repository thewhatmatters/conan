import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  cleanupStagedImages,
  IMAGE_STAGE_ROOT,
  ImageInputError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  prepareImageAttachments,
} from "./imageStaging.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/claude-image-user-message.json", import.meta.url),
    "utf8",
  ),
) as {
  message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> };
};
const source = fixture.message.content.find((block) => block.type === "image")?.source;
assert.ok(source);

test("accept -> stage retains verified inline bytes and creates a managed path", () => {
  const [image] = prepareImageAttachments([
    { mediaType: source.media_type, data: source.data },
  ]);
  assert.ok(image);
  try {
    assert.equal(image.data, source.data);
    assert.equal(image.bytes, Buffer.from(source.data, "base64").byteLength);
    assert.equal(path.dirname(image.stagedPath), IMAGE_STAGE_ROOT);
    assert.equal(fs.readFileSync(image.stagedPath).toString("base64"), source.data);

    const grok = JSON.parse(
      fs.readFileSync(
        new URL("./fixtures/grok-image-prompt-json.json", import.meta.url),
        "utf8",
      ),
    ) as Array<{ type: string; data?: string; mimeType?: string }>;
    assert.deepEqual(
      { type: "image", data: image.data, mimeType: image.mediaType },
      grok[0],
    );

    const codex = JSON.parse(
      fs.readFileSync(new URL("./fixtures/codex-image-argv.json", import.meta.url), "utf8"),
    ) as { args: string[] };
    assert.equal(codex.args.filter((arg) => arg === "-i").length, 2);
    assert.ok(fs.statSync(image.stagedPath).isFile());
  } finally {
    cleanupStagedImages([image]);
  }
  assert.equal(fs.existsSync(image.stagedPath), false);
});

test("staged paths must be managed regular files, never directories or traversal", () => {
  fs.mkdirSync(IMAGE_STAGE_ROOT, { recursive: true });
  assert.throws(
    () =>
      prepareImageAttachments([
        {
          type: "image",
          mediaType: source.media_type,
          data: source.data,
          stagedPath: IMAGE_STAGE_ROOT,
        },
      ]),
    (error: unknown) =>
      error instanceof ImageInputError && /not a file/.test(error.message),
  );
  assert.throws(
    () =>
      prepareImageAttachments([
        {
          type: "image",
          mediaType: source.media_type,
          data: source.data,
          stagedPath: path.join(IMAGE_STAGE_ROOT, "..", "outside.png"),
        },
      ]),
    (error: unknown) =>
      error instanceof ImageInputError && /does not exist|escapes/.test(error.message),
  );
});

test("oversize, invalid base64, and excess-count inputs fail clearly", () => {
  const oversize = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
  assert.throws(
    () => prepareImageAttachments([{ mediaType: "image/png", data: oversize }]),
    (error: unknown) =>
      error instanceof ImageInputError &&
      error.status === 413 &&
      /maximum/.test(error.message),
  );
  assert.throws(
    () => prepareImageAttachments([{ mediaType: "image/png", data: "not base64!" }]),
    /valid base64/,
  );
  assert.throws(
    () =>
      prepareImageAttachments(
        Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => ({
          mediaType: source.media_type,
          data: source.data,
        })),
      ),
    (error: unknown) =>
      error instanceof ImageInputError &&
      error.status === 413 &&
      /too many images/.test(error.message),
  );
});
