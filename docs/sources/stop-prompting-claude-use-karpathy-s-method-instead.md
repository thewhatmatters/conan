---
source: "https://www.youtube.com/watch?v=7zZy1QTvokM"
type: youtube
title: "Stop Prompting Claude. Use Karpathy's Method Instead."
ingested: 2026-06-16
tier: captions (keyless)
---

# Stop Prompting Claude. Use Karpathy's Method Instead.

**Source:** [YouTube](https://www.youtube.com/watch?v=7zZy1QTvokM) · Austin Marchese · 13:18 · ingested via keyless captions (no visual tier)

Distills Andrej Karpathy's approach (from his AISN 2026 talk + interviews) into a repeatable 3-layer method for working with coding agents. The thesis: most people prompt Claude wrong — they treat tasks as one-shot prompts instead of engineering the **spec**, the **verifier**, and the **environment** around the agent.

## The core gap (00:28–01:11)
- AI is brilliant at what's **measurable**, blind to what's **contextual**. Karpathy's example: "car wash 50m away — drive or walk?" Every SOTA model says walk; all miss that you need the *car* there to wash it (01:11). 
- A **spec** bridges the gap: "how you deliver your understanding to Claude in a format it can use" (01:11).
- Karpathy on plan mode: "I actually don't even like plan mode… there's something more general where you have to work with your agent to design a spec that is very detailed" (01:25). Plan mode isn't bad — it's too high-level. Go deeper.

## Layer 1 — The Spec (00:28–03:34)
Three moves to build a usable spec:
1. **Uncover the goal, not the task** (01:48). "Create an end-of-month report" is a task; the *goal* is the decision the report drives — something AI can never decide for you. Tactic: tell Claude **"interview me to identify the goal of this project"** — the way to get information out of your head and into the spec (02:04).
2. **Be agile, not waterfall** (02:13). Don't dump the whole task on the agent. Tight scope → clear checkpoint → review → adjust → repeat. Tactic: **"bias towards smaller and more compartmentalized specs"** (02:48).
3. **Be precise / use your brain** (02:54). Every assumption AI makes is a chance to drift. Think critically about what the generated spec says. Tactic: **"make me verify key decisions explicitly to ensure nothing is missed"** (03:13).
- Combined, these form one spec-creation prompt. He calls this "modern engineering" (03:27).

## Layer 2 — The Verifier (03:34–08:48)
Sits on top of the spec. Mental model: **"animals vs ghosts"** (03:53) — AI isn't a human (animal) with intrinsic motivation; yelling/pleading/"make it better" does nothing. The author's simpler reframe: a **robot librarian** that only answers from the books in its library and doesn't know when a book is missing — so it confidently makes things up (05:10–05:40). The only real lever is **verification** (05:49). Three places to focus:
1. **Set evaluation criteria up front** (06:04). "Make this report look good" → "the report must have 3 sections, each ending with a recommendation." Prompt: **"Outline the evaluation criteria you will use to ensure a high-quality final product. Be precise."** (06:34)
2. **Use a second model as critic** (06:43) — a different "librarian" with a different library grades the first's output. Tactical: install the Codex plugin in Claude Code: *"if this turns into a complex build, run the final output by Codex to ensure both systems agree"* (07:09).
3. **Pull external signal** (07:15) — connect the session to the real system (e.g. verify a deploy actually deployed) or feed historical reference docs, so verification rests on ground truth not vibes (07:25–07:56).
- Boris Cherney (creator of Claude Code): "If Claude has a feedback loop, it will 2–3x the quality of the final result" (08:07).

## Layer 3 — The Environment (08:48–12:36)
Where the spec + verifier live — "the workshop." Most people rebuild the workshop from scratch every session (a long chat history is NOT this). Four moves:
1. **A proper CLAUDE.md** (09:20) — injected on every prompt; the first thing Claude reads. His own has: how the repo works, custom skills + routing, knowledge/data architecture (where to look), and hard working rules. Example rule: "before building anything multi-step, include a verification plan" — forcing verification into every build (09:35). "Make this your environment. It's your world, and AI is living in it — not the other way around" (10:08).
2. **Build an LLM knowledge base** (10:15) — Karpathy's viral concept: a folder system of your own ingested training data, organized so Claude knows where information lives. "Your data is your moat… building your own intellectual data property" (10:32).
3. **Build your skill set** (10:40) — rule of thumb: anything you do repeatedly → a custom skill (a handbook for one task). "The best way to find a leak in a hose is to run water through it" — the more you use skills, the more they compound (10:53).
4. **Rules / guardrails by cost of error** (11:07). A CLAUDE.md line ("don't make up info", "don't touch /important") is a *request* Claude can ignore. For critical things, enforce at the **tool level** — a **PreToolUse hook** that blocks Write/Edit on protected files so Claude *literally can't* (11:53). Bucket actions into three: **always do** (autopilot), **ask first** (double-check), **never do** (hard lines) (12:12).

## The one thing to focus on (12:36–end)
Karpathy: **"You can outsource your thinking, but you can't outsource your understanding."** (12:55) All three layers center on *your* understanding of the bigger picture — your goals and what's needed to direct AI. That's the irreducible human part.

## Relevance to Conan
- Layer 1's "interview me → uncover the goal → agile/compartmentalized → verify key decisions" is the **direct blueprint for Conan's spec-first setup wizard** (the in-progress next-version idea). The wizard's payload = Layer 1, ending in PRD.md + prd.json.
- Layer 2 (verifier) maps to Conan's existing build-loop + Timeline observability — and the "second model as critic" / "external signal" ideas are future-version candidates.
- Layer 3 (environment) is what `craft-claude` + the skills ecosystem already do; a Conan onboarding could scaffold CLAUDE.md + a knowledge-base folder as a final step.
