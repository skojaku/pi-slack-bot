#!/usr/bin/env bash
# run.sh — Wrapper that runs pi-slack-bot with auto-restart support.
#
# The bot exits with code 75 to request a restart (e.g., via !restart command).
# Any other exit code stops the loop.
#
# Usage:
#   ./run.sh              # run in foreground
#   tmux new -d -s bot './run.sh'   # run in tmux

set -euo pipefail
cd "$(dirname "$0")"

RESTART_EXIT_CODE=75
RESTART_DELAY=2  # seconds between restart cycles

while true; do
  echo "[run.sh] Starting pi-slack-bot..."
  set +e
  npm start
  exit_code=$?
  set -e

  if [ "$exit_code" -eq "$RESTART_EXIT_CODE" ]; then
    echo "[run.sh] Bot requested restart (exit $RESTART_EXIT_CODE). Restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
    continue
  fi

  echo "[run.sh] Bot exited with code $exit_code. Stopping."
  exit "$exit_code"
done
