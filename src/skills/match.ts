// US-003 (v4.5): the "skills considered but not fired" heuristic — the novel
// piece of the Timeline. Claude doesn't expose its real skill-routing scoring,
// so we compute ours over each skill's frontmatter `description` and label it
// honestly as a heuristic in the UI ("Heuristic match" badge in US-004).
//
// Two layers:
//   1. BM25 (k1=1.2, b=0.75) over each skill's description (lower-cased,
//      stop-word-stripped, single-word tokens) vs the prompt's tokens. Pure,
//      zero deps, ~50 LOC of math.
//   2. A small categorical rule layer turns (score + cheap regexes) into the
//      human-readable `reason` the UI renders. The rules win over the score
//      thresholds when they fire — they're more interpretable.
//
// Pure module: no DB, no fs. Tested directly in scripts/test-skill-match.mjs.

import type { SkillEntry } from "./index.js";

/** BM25 saturation parameter. PRD-fixed at 1.2 (lucene-like). */
export const BM25_K1 = 1.2;
/** BM25 length-normalization parameter. PRD-fixed at 0.75 (lucene-like). */
export const BM25_B = 0.75;
/** Score threshold above which a row reads "strong description match". */
export const HIGH_SCORE_THRESHOLD = 1.5;
/** Score threshold above which a row reads "partial match" (below: "no match"). */
export const LOW_SCORE_THRESHOLD = 0.3;
/** How many top-contributing query terms to surface in the reason string. */
const TOP_TERMS = 3;

/**
 * Stop-word list. Small + Anglocentric on purpose — descriptions are short, so
 * even a fairly aggressive list still leaves enough content-bearing tokens for
 * BM25 to differentiate. Shared with the Conan `search` skill memory's BM25 in
 * spirit (the PRD called this out) — kept inline here to stay zero-dep.
 */
const STOP_WORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were",
  "will", "with", "you", "your", "i", "me", "my", "we", "our", "this", "these",
  "those", "what", "which", "when", "where", "why", "how", "do", "does", "did",
  "but", "or", "not", "no", "if", "then", "than", "so", "such", "up", "down",
  "out", "into", "about", "over", "under", "just", "like", "can", "could",
  "should", "would", "may", "might", "also", "any", "all", "each", "few",
  "more", "most", "some", "very", "one", "two", "three", "use", "using", "make",
  "want", "wants", "need", "needs", "get", "got", "set", "let", "lets",
]);

/**
 * Tokenize free text into BM25-ready terms: lower-case, strip everything that
 * isn't a letter / digit / hyphen / whitespace, then split on whitespace + `-`
 * so kebab-cased identifiers ("automate-browser") fan out into single-word
 * tokens. Drops stop words and short ≤1-char artifacts. Returns ordered tokens
 * (NOT deduped — TF needs duplicates).
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** A pre-tokenized skill document — internal to scoring. */
interface SkillDoc {
  readonly name: string;
  readonly description: string;
  readonly tokens: string[];
  readonly termFreq: Map<string, number>;
}

/** One per-term contribution to a skill's BM25 score (used for "top terms"). */
interface TermContribution {
  term: string;
  contribution: number;
}

/** Build a skill doc from a SkillEntry. */
function makeDoc(skill: SkillEntry): SkillDoc {
  const description = skill.description ?? "";
  const tokens = tokenize(description);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return { name: skill.name, description, tokens, termFreq };
}

/**
 * BM25 IDF for one query term: ln(1 + (N - df + 0.5) / (df + 0.5)) — the
 * smoothed "lucene" variant that's never negative and treats unseen terms as
 * maximally informative. N = #docs, df = #docs containing the term.
 */
function idf(termDf: number, totalDocs: number): number {
  return Math.log(1 + (totalDocs - termDf + 0.5) / (termDf + 0.5));
}

/**
 * Score one doc against the deduplicated query terms. Returns the total BM25
 * score AND the top contributing query terms (used by the "terms: a, b, c"
 * reason string).
 */
function scoreOneDoc(
  queryTerms: string[],
  doc: SkillDoc,
  idfByTerm: Map<string, number>,
  avgdl: number,
): { score: number; topTerms: string[] } {
  const dl = doc.tokens.length || 1;
  let score = 0;
  const contributions: TermContribution[] = [];
  for (const q of queryTerms) {
    const tf = doc.termFreq.get(q) ?? 0;
    if (tf === 0) continue;
    const idfQ = idfByTerm.get(q) ?? 0;
    if (idfQ === 0) continue;
    const numer = tf * (BM25_K1 + 1);
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
    const contrib = idfQ * (numer / denom);
    score += contrib;
    contributions.push({ term: q, contribution: contrib });
  }
  contributions.sort((a, b) => b.contribution - a.contribution);
  return {
    score,
    topTerms: contributions.slice(0, TOP_TERMS).map((c) => c.term),
  };
}

// --- Rule layer -----------------------------------------------------------

/** Description keywords that mark a UI-flavored skill. */
const UI_DESC_KEYS = ["browser", "verify", "ui"];
/** Prompt verbs that signal the user wants a UI action. */
const UI_PROMPT_VERBS = ["render", "screenshot", "click", "style"];
/** Diagram-domain keywords (must appear in BOTH description and prompt). */
const DIAGRAM_KEYS = ["diagram", "chart", "flowchart"];

/** Build a "(terms: a, b, c)" or "(none)" tail for the reason string. */
function termsList(top: string[]): string {
  return top.length ? top.join(", ") : "none";
}

/**
 * True when `promptLower` mentions the skill by name — either as the kebab
 * form (`automate-browser`), the space-flattened form (`automate browser`), or
 * every kebab-segment appears among the prompt tokens (`use automate the
 * browser` would still match). Falls back to the raw substring when the skill
 * name has no kebab.
 */
function promptMentionsSkill(
  skillName: string,
  promptLower: string,
  promptTokens: ReadonlySet<string>,
): boolean {
  const kebab = skillName.toLowerCase().trim();
  if (!kebab) return false;
  if (promptLower.includes(kebab)) return true;
  if (kebab.includes("-")) {
    const spaced = kebab.replace(/-/g, " ");
    if (promptLower.includes(spaced)) return true;
    const parts = kebab.split("-").filter((p) => p.length > 1);
    if (parts.length > 0 && parts.every((p) => promptTokens.has(p))) return true;
  }
  return false;
}

/**
 * Pick the categorical reason for a (skill, score) pair. Rules win over score
 * thresholds when they fire — they're more interpretable to the user.
 */
export function classifyReason(input: {
  skillName: string;
  description: string;
  promptLower: string;
  promptTokens: ReadonlySet<string>;
  score: number;
  topTerms: string[];
}): string {
  const descriptionLower = input.description.toLowerCase();

  if (promptMentionsSkill(input.skillName, input.promptLower, input.promptTokens)) {
    return "prompt mentions this skill";
  }

  const descHasUiKey = UI_DESC_KEYS.some((k) => descriptionLower.includes(k));
  const promptHasUiVerb = UI_PROMPT_VERBS.some((v) => input.promptTokens.has(v));
  if (descHasUiKey && promptHasUiVerb) return "UI keyword match";

  const descHasDiagram = DIAGRAM_KEYS.some((k) => descriptionLower.includes(k));
  const promptHasDiagram = DIAGRAM_KEYS.some((k) => input.promptLower.includes(k));
  if (descHasDiagram && promptHasDiagram) return "diagram intent";

  const tail = termsList(input.topTerms);
  if (input.score >= HIGH_SCORE_THRESHOLD) {
    return `strong description match (terms: ${tail})`;
  }
  if (input.score >= LOW_SCORE_THRESHOLD) {
    return `partial match (terms: ${tail})`;
  }
  return `no description match (top terms: ${tail})`;
}

/** One scored row returned by scoreSkills (the public entry point). */
export interface SkillMatch {
  skill: string;
  score: number;
  reason: string;
}

/**
 * Score every installed skill against the prompt. Returns one row per skill
 * (UNSORTED — the caller picks a top-N by score). Each row carries the BM25
 * score and the categorical reason the UI renders.
 *
 * Honest by construction:
 *   - An empty prompt or empty skills list returns [] (never fabricates rows).
 *   - A skill with no description still gets scored, but its terms are empty so
 *     BM25 contributes nothing; the rules can still match its name + a UI verb
 *     in the prompt.
 *   - Every reason string ends with the actual top contributing terms — never
 *     made up.
 */
export function scoreSkills(prompt: string, skills: SkillEntry[]): SkillMatch[] {
  if (!prompt || skills.length === 0) return [];

  const promptLower = prompt.toLowerCase();
  const promptTokensList = tokenize(prompt);
  // Dedup for the IDF/per-doc loop; the set form is for the rule layer's
  // membership checks.
  const queryTerms = Array.from(new Set(promptTokensList));
  const promptTokens = new Set(promptTokensList);

  const docs = skills.map(makeDoc);
  const totalDocs = docs.length;
  const avgdlRaw =
    docs.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(1, totalDocs);
  const avgdl = avgdlRaw > 0 ? avgdlRaw : 1;

  // Document frequency per query term.
  const dfByTerm = new Map<string, number>();
  for (const q of queryTerms) {
    let count = 0;
    for (const d of docs) {
      if (d.termFreq.has(q)) count++;
    }
    dfByTerm.set(q, count);
  }
  const idfByTerm = new Map<string, number>();
  for (const [q, df] of dfByTerm) {
    idfByTerm.set(q, idf(df, totalDocs));
  }

  const out: SkillMatch[] = [];
  for (let i = 0; i < skills.length; i++) {
    const sk = skills[i];
    const doc = docs[i];
    if (!sk || !doc) continue;
    const { score, topTerms } = scoreOneDoc(queryTerms, doc, idfByTerm, avgdl);
    const reason = classifyReason({
      skillName: sk.name,
      description: doc.description,
      promptLower,
      promptTokens,
      score,
      topTerms,
    });
    out.push({ skill: sk.name, score, reason });
  }
  return out;
}

/** How many top-scored skills the ingest path persists per prompt. */
export const CONSIDERATION_TOP_N = 8;

/**
 * Pick the top N matches by score, descending. Ties broken by skill name
 * (alphabetical) so the persisted row order is stable across runs.
 */
export function topMatches(
  matches: SkillMatch[],
  n: number = CONSIDERATION_TOP_N,
): SkillMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.localeCompare(b.skill);
  });
  return sorted.slice(0, Math.max(0, n));
}
