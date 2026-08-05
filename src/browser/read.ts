/**
 * Page reader for the Browser surface's agent context (WHA-109).
 *
 * The Browser surface is an `<iframe>`, so the renderer cannot read a word of
 * a cross-origin page — same-origin policy, and no per-origin "grant" changes
 * that. The gateway can: it fetches the URL itself and reduces the HTML to a
 * bounded text snapshot the model can read. That detour buys the privacy
 * criterion for free — a gateway fetch carries no browser credentials, so
 * cookies, `Authorization` headers, and HTTP-only session state cannot reach
 * the model context by this path even in principle.
 *
 * The honest limit, reported on every snapshot rather than hidden: this is the
 * *served* HTML, not the *painted* DOM. A client-rendered SPA (the exact thing
 * the surface exists to preview) ships an empty shell and paints from JS, so
 * its snapshot is nearly textless. `clientRendered` flags that shape so the
 * tool result can say "this page renders client-side, I read its shell" rather
 * than implying the page is blank. Reading the painted DOM needs a real
 * webview, which is the Tauri child-webview spike (see CLAUDE.md), not this.
 *
 * Sibling to `./probe.ts`, and deliberately the same shape: bounded, never
 * throws, failure is data.
 */

/** A bounded text snapshot of one page, plus the caveats that qualify it. */
export interface PageSnapshot {
  /** Post-redirect URL the text actually came from. */
  url: string;
  /** `<title>` text, or null when the document has none. */
  title: string | null;
  /** Extracted, whitespace-collapsed body text (empty string when none). */
  text: string;
  /** True when `text` was cut at MAX_TEXT_CHARS. */
  truncated: boolean;
  /**
   * True when the page looks client-rendered — near-empty extracted text
   * alongside real script tags. The snapshot is still returned; this says
   * "what I read is the shell, not what the user sees."
   */
  clientRendered: boolean;
  /** HTTP status of the (post-redirect) response. */
  status: number;
  /** Response `content-type`, lowercased, sans parameters. */
  contentType: string;
}

/** A failed read. Never thrown — returned, like `probeUrl`'s unreachable. */
export interface PageReadError {
  error: string;
  /** Status when the server answered but the response was unusable. */
  status: number | null;
}

export type PageReadResult = PageSnapshot | PageReadError;

export function isReadError(result: PageReadResult): result is PageReadError {
  return "error" in result;
}

/** Text handed to a model, bounded so one page cannot eat a context window. */
export const MAX_TEXT_CHARS = 24_000;
/** Bytes read off the wire before we stop — a guard against endless streams. */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;

/** Elements whose text content is markup machinery, never page copy. */
const STRIPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "head"];

/** The named entities worth resolving; numeric refs are handled separately. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decode the entity forms that survive into extracted text. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The document's `<title>`, decoded and collapsed, or null. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1] ?? "").replace(/\s+/g, " ").trim();
  return title || null;
}

/**
 * Reduce HTML to readable text: drop machinery elements wholesale (including
 * their content), turn block boundaries into newlines so structure survives,
 * strip every remaining tag, decode entities, and collapse runs of whitespace.
 *
 * This is a bounded regex reduction, not a parser. It is the right tool here —
 * the output is prose for a model to read, so a malformed-markup edge case
 * costs a stray word, not a correctness bug, and the alternative is a parser
 * dependency for a job that does not need one.
 */
export function htmlToText(html: string): string {
  let out = html;
  // Comments first — they can contain anything, including fake tags.
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of STRIPPED_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    // Unclosed machinery (a truncated body cuts mid-<script>) would otherwise
    // leak its source into the text; drop from the open tag to the end.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  }
  // Source newlines are formatting, not content — HTML collapses them to a
  // space when it paints. Flatten BEFORE structural breaks are inserted, or
  // every 80-column-wrapped source line becomes a bogus paragraph break.
  // (Consequence, deliberate: <pre> whitespace collapses too. Faithful code
  // formatting would need a real parser, and this output is prose for a model.)
  out = out.replace(/\s+/g, " ");
  // Now the only newlines in play are the ones document structure earns.
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote)\s*>/gi, "\n");
  // Tags go before entities are decoded, so an escaped `&lt;script&gt;` in the
  // page's own copy is read as text instead of becoming a tag we then strip.
  out = out.replace(/<[^>]*>/g, " ");
  out = decodeEntities(out);
  out = out.replace(/[^\S\n]+/g, " ");
  out = out.replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * A page is judged client-rendered when it shipped real scripts but almost no
 * text. The threshold is deliberately low: a Vite/CRA shell extracts to a
 * handful of characters ("You need to enable JavaScript to run this app"),
 * while even a sparse server-rendered page clears it comfortably.
 */
const CLIENT_RENDERED_MAX_CHARS = 200;

export function looksClientRendered(html: string, text: string): boolean {
  if (text.length > CLIENT_RENDERED_MAX_CHARS) return false;
  return /<script\b/i.test(html);
}

/** Read at most `MAX_HTML_BYTES` of a response body as UTF-8. */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_HTML_BYTES) break;
    }
  } finally {
    // Releases the socket whether we finished the body or bailed at the cap.
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, Math.min(total, MAX_HTML_BYTES)).toString("utf8");
}

/**
 * Fetch a page and reduce it to a bounded snapshot. Never throws — every
 * failure resolves to a `PageReadError`, matching `probeUrl`'s contract.
 *
 * `redirect: "follow"` is intentional (the snapshot should describe where the
 * user actually lands), and no credentials are attached: this fetch runs in the
 * gateway process, which holds none of the user's browser state.
 */
export async function readPage(url: string): Promise<PageReadResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return {
      error: cause?.message || (error as Error).message || "connection failed",
      status: null,
    };
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const textual =
    contentType === "" || contentType.startsWith("text/") || contentType.includes("xml") ||
    contentType === "application/json";
  if (!textual) {
    void response.body?.cancel().catch(() => {});
    return {
      error: `cannot read ${contentType} as text — the Browser surface reads HTML and text pages`,
      status: response.status,
    };
  }

  let html: string;
  try {
    html = await readBounded(response);
  } catch (error) {
    return { error: (error as Error).message || "could not read the response body", status: response.status };
  }

  const isHtml = contentType.startsWith("text/html") || contentType.includes("xhtml");
  const extracted = isHtml ? htmlToText(html) : html.trim();
  const truncated = extracted.length > MAX_TEXT_CHARS;
  return {
    url: response.url || url,
    title: isHtml ? extractTitle(html) : null,
    text: truncated ? extracted.slice(0, MAX_TEXT_CHARS) : extracted,
    truncated,
    clientRendered: isHtml && looksClientRendered(html, extracted),
    status: response.status,
    contentType: contentType || "text/html",
  };
}
