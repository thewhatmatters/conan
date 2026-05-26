#!/usr/bin/env bash
# usage-guard.sh — pre-reset usage safety for the v3 loop.
#
# Waits until START (default 10) stories pass, then after EACH subsequent story
# completion checks the live 5-hour usage via check-usage.mjs. It runs the checks
# itself (in the background) and only exits — re-invoking the agent — when a
# decision is needed:
#   PAUSE  — 5h usage > THRESHOLD% → agent stops the loop + schedules the
#            12:21am resume (resume-loop-v3.sh) which then runs to exhaustion
#            with NO usage checks (per user: after the reset, just finish).
#   DONE   — all stories pass.
#   ENDED  — the loop process died before finishing.
# Each check is logged to conan-loop.log so there's a trail.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

THRESHOLD="${THRESHOLD:-90}"
START="${START:-10}"
PRD="${PRD:-prd.json}"

passing() { python3 -c "import json;print(sum(1 for s in json.load(open('$PRD'))['userStories'] if s.get('passes')))" 2>/dev/null || echo 0; }
total()   { python3 -c "import json;print(len(json.load(open('$PRD'))['userStories']))" 2>/dev/null || echo 48; }
usage_pct() {
  node scripts/check-usage.mjs 2>/dev/null | python3 -c "import sys,json
try:
    d=json.loads(sys.stdin.read().strip().splitlines()[-1])
    v=d.get('maxUsedPercent')
    print(v if v is not None else -1)
except Exception:
    print(-1)"
}

log() { printf '[%s] usage-guard: %s\n' "$(date '+%F %T')" "$1" >> conan-loop.log; }

log "started (START=$START, THRESHOLD=${THRESHOLD}%)"
last=0
while true; do
  n="$(passing)"; t="$(total)"
  if [ "$n" -ge "$t" ]; then echo "DONE $n/$t"; log "DONE $n/$t"; exit 0; fi
  if ! pgrep -f 'run-tasks.sh' >/dev/null 2>&1; then echo "ENDED $n/$t"; log "ENDED $n/$t (loop gone)"; exit 2; fi
  if [ "$n" -ge "$START" ] && [ "$n" -gt "$last" ]; then
    pct="$(usage_pct)"
    log "after story $n/$t → 5h usage ${pct}%"
    if [ "$pct" -ge 0 ] && [ "$pct" -gt "$THRESHOLD" ]; then
      echo "PAUSE n=$n usage=${pct}%"; log "PAUSE — usage ${pct}% > ${THRESHOLD}% at $n/$t"; exit 1
    fi
    last="$n"
  fi
  sleep 30
done
