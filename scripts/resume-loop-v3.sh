#!/usr/bin/env bash
# resume-loop-v3.sh — resume the Conan v3 build loop after a usage-limit pause.
#
# run-tasks.sh always targets the lowest-priority still-failing story, so simply
# re-running it continues where the loop left off (no extra state needed).
# Created by the usage-pause safeguard: if usage exceeded 90% after the first 10
# stories, the loop was stopped and this is scheduled to fire at 12:21am (just
# after the 12:20am reset) to finish the remaining stories.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
unset CONAN_PORT
echo "[$(date '+%F %T')] resume-loop-v3: relaunching run-tasks.sh after usage reset" >> conan-loop.log
AGENT_CMD="claude -p --dangerously-skip-permissions" MAX_ITER=60 ./run-tasks.sh >> conan-loop.log 2>&1
