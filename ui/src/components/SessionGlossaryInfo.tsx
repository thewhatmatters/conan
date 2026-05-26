/**
 * The "Session" glossary info tooltip (US-020). A Session = one Claude Code
 * *run* (an agent conversation/instance), keyed by session_id — NOT a
 * browser/login session. Rendered wherever sessions are surfaced so the term
 * isn't ambiguous. Uses a native title tooltip (semantic tokens, no deps).
 */
export const SESSION_GLOSSARY =
  "A Session is one Claude Code run (an agent conversation/instance), keyed by " +
  "session_id — observed (a hooked claude self-reports) or driven (launched by " +
  "Conan). Not a browser/login session.";

export default function SessionGlossaryInfo() {
  return (
    <span
      title={SESSION_GLOSSARY}
      aria-label={SESSION_GLOSSARY}
      role="img"
      tabIndex={0}
      className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground hover:bg-muted"
    >
      i
    </span>
  );
}
