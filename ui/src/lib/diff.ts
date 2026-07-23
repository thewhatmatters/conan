/**
 * Dependency-free line diff for the transcript's file-edit tool cards
 * (US-021). Edit/Write/MultiEdit inputs carry the before/after text right in
 * the tool_use payload, so the patch is derived client-side — no gateway
 * round-trip and it works identically for live turns and JSONL-restored
 * history.
 */

export type DiffLineType = "ctx" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  /** Rendered patch lines (MultiEdit hunks separated by a `hunk` row), or
   *  null when degraded — binary content or too large to diff/render. */
  lines: DiffLine[] | null;
  /** Why `lines` is null, for the degraded summary line. */
  degraded?: "binary" | "too-large";
}

/** Beyond this many chars of before+after text, skip diffing entirely —
 *  the card degrades to a `+N −M` summary line. */
const MAX_DIFF_CHARS = 200_000;
/** LCS is O(n·m); beyond this product the middle section falls back to
 *  plain del-all/add-all (still a correct patch, just not minimal). */
const MAX_LCS_CELLS = 250_000;

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  // A trailing newline would otherwise read as a phantom empty last line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-level diff of two text blocks: common prefix/suffix trimmed, LCS on
 *  the middle. Deletions precede additions within a changed run. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = a
    .slice(0, start)
    .map((text) => ({ type: "ctx" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    out.push(
      ...midA.map((text) => ({ type: "del" as const, text })),
      ...midB.map((text) => ({ type: "add" as const, text })),
    );
  } else {
    const m = midA.length;
    const n = midB.length;
    // dp[i][j] = LCS length of midA[i..] vs midB[j..], flattened row-major.
    const w = n + 1;
    const dp = new Int32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * w + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * w + j + 1]! + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        out.push({ type: "ctx", text: midA[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        out.push({ type: "del", text: midA[i]! });
        i++;
      } else {
        out.push({ type: "add", text: midB[j]! });
        j++;
      }
    }
    while (i < m) out.push({ type: "del", text: midA[i++]! });
    while (j < n) out.push({ type: "add", text: midB[j++]! });
  }

  out.push(...a.slice(endA).map((text) => ({ type: "ctx" as const, text })));
  return out;
}

/** One before/after pair extracted from a file-edit tool input. */
interface EditHunk {
  oldText: string;
  newText: string;
}

/** Pull `{path, hunks}` out of an Edit / Write / MultiEdit tool_use input.
 *  Returns null for anything else (malformed input, other tools) — the card
 *  then falls back to the generic JSON input view. */
function parseFileEdit(name: string, input: unknown): { path: string; hunks: EditHunk[] } | null {
  if (input == null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const path = o.file_path;
  if (typeof path !== "string" || !path) return null;
  if (name === "Edit") {
    if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
    return { path, hunks: [{ oldText: o.old_string, newText: o.new_string }] };
  }
  if (name === "Write") {
    if (typeof o.content !== "string") return null;
    // No before-image in the payload — an overwrite renders as all-additions.
    return { path, hunks: [{ oldText: "", newText: o.content }] };
  }
  if (name === "MultiEdit") {
    if (!Array.isArray(o.edits)) return null;
    const hunks: EditHunk[] = [];
    for (const e of o.edits) {
      if (e == null || typeof e !== "object") return null;
      const ed = e as Record<string, unknown>;
      if (typeof ed.old_string !== "string" || typeof ed.new_string !== "string") return null;
      hunks.push({ oldText: ed.old_string, newText: ed.new_string });
    }
    return hunks.length > 0 ? { path, hunks } : null;
  }
  return null;
}

/** Build the inline diff for a file-edit tool card, or null when the tool
 *  isn't a recognized file edit. Binary/huge content degrades to counts-only
 *  (`lines: null`) so a giant Write can't lock up the transcript. */
export function buildFileDiff(name: string, input: unknown): FileDiff | null {
  const parsed = parseFileEdit(name, input);
  if (!parsed) return null;

  let chars = 0;
  let binary = false;
  for (const h of parsed.hunks) {
    chars += h.oldText.length + h.newText.length;
    if (h.oldText.includes("\u0000") || h.newText.includes("\u0000")) binary = true;
  }
  if (binary || chars > MAX_DIFF_CHARS) {
    // Naive counts (whole hunks as removed/added) — good enough for the
    // summary line the degraded card shows.
    let added = 0;
    let removed = 0;
    for (const h of parsed.hunks) {
      removed += splitLines(h.oldText).length;
      added += splitLines(h.newText).length;
    }
    return { path: parsed.path, added, removed, lines: null, degraded: binary ? "binary" : "too-large" };
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  parsed.hunks.forEach((h, i) => {
    if (i > 0) lines.push({ type: "hunk", text: "" });
    for (const l of lineDiff(h.oldText, h.newText)) {
      if (l.type === "add") added++;
      else if (l.type === "del") removed++;
      lines.push(l);
    }
  });
  return { path: parsed.path, added, removed, lines };
}
