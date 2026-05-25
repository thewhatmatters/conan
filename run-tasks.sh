#!/usr/bin/env bash
# run-tasks.sh — autonomous task runner for a decompose-prd prd.json.
#
# Loops a FRESH agent instance over the user stories in prd.json until every
# story passes. Each iteration has no memory of the last — which is why stories
# must be sized to one iteration (that is decompose-prd's whole job).
#
# Usage-aware: if an iteration hits a Claude usage/rate limit, the loop surfaces
# the reset info, waits (until the parsed reset time, else USAGE_BACKOFF), then
# RESUMES the same story. Resume-where-left-off is inherent — the next target is
# always the lowest-priority story still failing, so re-running continues.
#
# Config (environment overrides):
#   AGENT_CMD      command that takes a prompt on stdin and runs one agent turn.
#                  default: "claude -p". For unattended runs:
#                    AGENT_CMD="claude -p --permission-mode acceptEdits --allowedTools Bash"
#   PRD            task file (default: prd.json)
#   MAX_ITER       safety cap on iterations (default: 50)
#   USAGE_BACKOFF  seconds to wait on a usage limit if no reset time is parseable (default: 1800)
#   MAX_STALL      stop after this many no-progress iterations on the same story (default: 3)
#   VALIDATE       path to decompose-prd's validate.py
set -uo pipefail

AGENT_CMD="${AGENT_CMD:-claude -p}"
PRD="${PRD:-prd.json}"
MAX_ITER="${MAX_ITER:-50}"
USAGE_BACKOFF="${USAGE_BACKOFF:-1800}"
MAX_STALL="${MAX_STALL:-3}"
VALIDATE="${VALIDATE:-$HOME/.claude/skills/decompose-prd/scripts/validate.py}"
PROGRESS="progress.txt"

[ -f "$PRD" ] || { echo "no $PRD here — run decompose-prd first" >&2; exit 1; }

branch="$(python3 -c "import json;print(json.load(open('$PRD')).get('branchName',''))")"

# On a feature (branchName) change, archive the prior run if it has real
# progress, then point progress.txt at the new feature either way.
if [ -f "$PROGRESS" ]; then
  prev="$(sed -n '1s/^# run: //p' "$PROGRESS")"
  if [ -n "$prev" ] && [ "$prev" != "$branch" ]; then
    if [ "$(wc -l < "$PROGRESS")" -gt 1 ]; then
      dir="archive/$(date +%F)-${prev##*/}"
      mkdir -p "$dir" && cp "$PRD" "$PROGRESS" "$dir"/ 2>/dev/null || true
      echo "archived previous run ($prev) → $dir" >&2
    fi
    printf '# run: %s\n' "$branch" > "$PROGRESS"
  fi
else
  printf '# run: %s\n' "$branch" > "$PROGRESS"
fi

all_pass() {
  python3 -c "import json,sys;d=json.load(open('$PRD'));sys.exit(0 if d.get('userStories') and all(s.get('passes') for s in d['userStories']) else 1)"
}

# id + title of the lowest-priority story still failing (the next target).
target() {
  python3 -c "import json;s=sorted((x for x in json.load(open('$PRD')).get('userStories',[]) if not x.get('passes')),key=lambda x:x.get('priority',0));print(f\"{s[0].get('id','?')}: {s[0].get('title','?')}\" if s else '')"
}

# Seconds until a "resets at H[:MM][am/pm]" mentioned in $1; else USAGE_BACKOFF.
reset_seconds() {
  python3 - "$USAGE_BACKOFF" "$1" <<'PY'
import sys, re, datetime
default = int(sys.argv[1]); text = sys.argv[2] if len(sys.argv) > 2 else ""
m = re.search(r'reset[^0-9]*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?', text, re.I)
if not m:
    print(default); raise SystemExit
h = int(m.group(1)); mn = int(m.group(2) or 0); ap = (m.group(3) or '').lower()
if ap == 'pm' and h < 12: h += 12
if ap == 'am' and h == 12: h = 0
now = datetime.datetime.now()
tgt = now.replace(hour=h % 24, minute=mn, second=0, microsecond=0)
if tgt <= now: tgt += datetime.timedelta(days=1)
secs = int((tgt - now).total_seconds())
# A parsed reset >6h out is suspect (session windows are short, and a same-day
# time already passed rolls to tomorrow) — fall back to the default backoff.
if secs > 21600: secs = default
print(max(60, secs))
PY
}

read -r -d '' PROMPT <<'EOF' || true
You are ONE iteration of an autonomous build loop with no memory of prior runs.
The source of truth is prd.json and progress.txt in the current directory.

1. Read prd.json. Pick the lowest-`priority` user story whose `passes` is false.
   If every story already passes, say so and stop without changing anything.
2. Implement exactly that ONE story. Satisfy every item in its
   acceptanceCriteria. Use the skills named in its criteria/notes (for example,
   verify UI changes with the automate-browser skill).
3. Verify: the typecheck — plus any tests or browser checks the criteria call
   for — must actually pass.
4. Only once it genuinely passes: set that story's "passes" to true in prd.json,
   append one line to progress.txt summarising what you did, and commit.
Do not start a second story. Never mark a story passing that you did not verify.
EOF

stall=0
last_tgt=""
for ((i = 1; i <= MAX_ITER; i++)); do
  if all_pass; then
    echo "✅ all stories pass — done after $((i - 1)) iteration(s)"
    exit 0
  fi
  if [ -f "$VALIDATE" ]; then
    python3 "$VALIDATE" --in "$PRD" >/dev/null \
      || { echo "⛔ $PRD failed validation — fix it before running" >&2; exit 1; }
  fi

  tgt="$(target)"

  # Stall guard: bail if the same story fails MAX_STALL times in a row.
  if [ "$tgt" = "$last_tgt" ]; then stall=$((stall + 1)); else stall=0; fi
  last_tgt="$tgt"
  if [ "$stall" -ge "$MAX_STALL" ]; then
    echo "⚠ no progress on [$tgt] after $MAX_STALL attempts — stopping for review" >&2
    printf '[%s] STALLED on %s after %d attempts — stopping\n' "$(date '+%F %T')" "$tgt" "$MAX_STALL" >> "$PROGRESS"
    exit 1
  fi

  echo "── iteration $i → $tgt ──────────────────────" >&2
  printf '[%s] iteration %d → %s\n' "$(date '+%F %T')" "$i" "$tgt" >> "$PROGRESS"

  out="$(printf '%s\n' "$PROMPT" | $AGENT_CMD 2>&1)" || true
  printf '%s\n' "$out"

  # Usage / rate limit? Surface reset info, wait, then resume the same story.
  # Match only Claude's REAL limit banner, not stories that merely discuss
  # limits/usage (US-023 cost ceiling, US-030 usage widget). The "· resets <t>"
  # middot banner + "hit your … limit" are the distinctive real signals.
  if printf '%s' "$out" | grep -qiE '·[[:space:]]*resets|hit your (session|usage|account) limit|usage limit reached|reached your (usage|session) limit|too many requests|status 429|http 429'; then
    line="$(printf '%s' "$out" | grep -iE 'reset|limit' | head -1 | tr -s ' ' | cut -c1-160)"
    secs="$(reset_seconds "$out")"
    msg="⏳ usage limit — ${line:-no detail}; resuming [$tgt] in ${secs}s"
    echo "$msg" >&2
    printf '[%s] %s\n' "$(date '+%F %T')" "$msg" >> "$PROGRESS"
    stall=0; last_tgt=""   # a limit pause is not a stall
    sleep "$secs"
    continue
  fi
done

echo "⚠ hit MAX_ITER=$MAX_ITER without all stories passing" >&2
exit 1
