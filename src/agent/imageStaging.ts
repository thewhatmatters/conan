import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentImageAttachment } from "./attachments.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 4;
export const IMAGE_STAGE_ROOT = path.join(os.tmpdir(), "conan-images");
const STAGE_TTL_MS = 10 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export class ImageInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ImageInputError";
  }
}

function decodeBase64(value: unknown): { data: string; buffer: Buffer } {
  if (typeof value !== "string" || value.length === 0) {
    throw new ImageInputError("image data must be non-empty base64");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ImageInputError("image data is not valid base64");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    throw new ImageInputError("image data is not canonical base64");
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageInputError(
      `image is ${buffer.byteLength} bytes; maximum is ${MAX_IMAGE_BYTES}`,
      413,
    );
  }
  return { data: value, buffer };
}

function assertManagedFile(stagedPath: string): void {
  const root = fs.realpathSync(IMAGE_STAGE_ROOT);
  let resolved: string;
  try {
    resolved = fs.realpathSync(stagedPath);
  } catch {
    throw new ImageInputError("staged image path does not exist");
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new ImageInputError("staged image path escapes Conan's temp directory");
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new ImageInputError("staged image path is not a file");
  }
}

function scheduleCleanup(stagedPath: string): void {
  const timer = setTimeout(() => cleanupStagedImages([{ stagedPath }]), STAGE_TTL_MS);
  timer.unref();
}

function purgeExpiredStagedImages(): void {
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const name of fs.readdirSync(IMAGE_STAGE_ROOT)) {
    const candidate = path.join(IMAGE_STAGE_ROOT, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(candidate);
    } catch {
      /* raced another cleanup */
    }
  }
}

/** Validate browser image frames and materialize path + inline representations.
 * Existing staged frames are accepted only when their path resolves to a
 * regular file below Conan's managed temp root.
 */
export function prepareImageAttachments(value: unknown): AgentImageAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ImageInputError("images must be an array");
  }
  if (value.length > MAX_IMAGE_COUNT) {
    throw new ImageInputError(
      `too many images: received ${value.length}; maximum is ${MAX_IMAGE_COUNT}`,
      413,
    );
  }

  fs.mkdirSync(IMAGE_STAGE_ROOT, { recursive: true, mode: 0o700 });
  // Makes cleanup survive a gateway restart: every new staging request reaps
  // expired regular files left by an earlier process.
  purgeExpiredStagedImages();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ImageInputError(`image ${index + 1} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (item.type !== undefined && item.type !== "image") {
      throw new ImageInputError(`image ${index + 1} has an invalid type`);
    }
    if (typeof item.mediaType !== "string" || !EXTENSIONS[item.mediaType]) {
      throw new ImageInputError(
        `image ${index + 1} mediaType must be image/png, image/jpeg, image/gif, or image/webp`,
      );
    }
    const { data, buffer } = decodeBase64(item.data);

    if (typeof item.stagedPath === "string") {
      assertManagedFile(item.stagedPath);
      return {
        type: "image",
        mediaType: item.mediaType,
        data,
        bytes: buffer.byteLength,
        stagedPath: fs.realpathSync(item.stagedPath),
      };
    }

    const stagedPath = path.join(
      IMAGE_STAGE_ROOT,
      `${randomUUID()}${EXTENSIONS[item.mediaType]}`,
    );
    fs.writeFileSync(stagedPath, buffer, { flag: "wx", mode: 0o600 });
    scheduleCleanup(stagedPath);
    return {
      type: "image",
      mediaType: item.mediaType,
      data,
      bytes: buffer.byteLength,
      stagedPath,
    };
  });
}

/** Idempotently remove only files previously validated beneath the stage root. */
export function cleanupStagedImages(
  images: Array<Pick<AgentImageAttachment, "stagedPath">>,
): void {
  for (const image of images) {
    try {
      assertManagedFile(image.stagedPath);
      fs.unlinkSync(image.stagedPath);
    } catch {
      // Cleanup is best-effort and idempotent. Validation still prevents this
      // helper from unlinking arbitrary paths.
    }
  }
}
