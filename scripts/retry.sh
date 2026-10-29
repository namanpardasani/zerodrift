#!/bin/bash
# Retry a flaky command (e.g. package installs on an unreliable network).
# usage: scripts/retry.sh pnpm --filter @zerodrift/foo add bar --no-frozen-lockfile
# Note: CI=true makes pnpm installs "frozen" (lockfile must already match); pass --no-frozen-lockfile when adding deps.
export CI=true
for i in 1 2 3 4 5 6; do
  if timeout 240 "$@"; then exit 0; fi
  echo "attempt $i failed, retrying" >&2; sleep 3
done
exit 1
