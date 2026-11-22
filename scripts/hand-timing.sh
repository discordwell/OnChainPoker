#!/usr/bin/env bash
# Times whole hands on local three-validator networks, from the chain's own block times: from
# StartHand to the first player decision being possible, and from StartHand to the showdown result.
# The players are bots that call or check as soon as they may, so the time is the machinery's.
# Same chain build and settings as scripts/liveness-repro.sh.
#
#   bash scripts/hand-timing.sh                       2 and 6 players, at 5 s and at 1 s blocks, 5 hands each
#   CONFIGS="2:5" HANDS=10 bash scripts/hand-timing.sh  players:block seconds, one network per entry
#   KEEP=1 ...                                        leave the processes and homes in .tmp/hand-timing
#
# Prints one table per network (scripts/liveness/hand-times.mjs) and keeps it in
# .tmp/hand-timing/<players>p-<seconds>s/timing.txt beside the events it was read from.

set -euo pipefail
WORK="${WORK:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.tmp/hand-timing}"
BASE_PORT="${BASE_PORT:-42000}"
source "$(dirname "${BASH_SOURCE[0]}")/liveness/lib.sh"

CONFIGS="${CONFIGS:-2:5 6:5 2:1 6:1}"
HANDS="${HANDS:-5}"

time_hands() { # players
  local players="$1" i fin from
  net_init "$players"
  net_start
  for i in 0 1 2; do daemon_start "$i"; done
  for ((i = 0; i < players; i++)); do BOT_POLL_INTERVAL_MS=250 bot_start "$i"; done
  fin="$(ev_wait DealerEpochFinalized "$INITIAL_HEIGHT" 560 epochId=1)" || die "epoch 1 was not finalized"
  # The hand that was waiting for the epoch is not timed, nor one that started before every player sat.
  ev_wait HandCompleted "${fin%% *}" 1500 >/dev/null || die "no hand completed"
  from="$(ev_scanned)"
  say "epoch 1 dealing; timing $HANDS hands started after height $from"
  while (($(node "$LIVENESS_DIR/hand-times.mjs" "$EVENTS" --from "$from" --players "$players" --json | jq '.summary.hands') < HANDS)); do
    (($(ev_scanned) < from + HANDS * 1500)) || die "fewer than $HANDS hands in $((HANDS * 1500)) blocks"
    ev_sync $(($(ev_scanned) + 5))
  done
  {
    echo "== $players players, ${BLOCK_SECONDS} s blocks (load average $(uptime | sed 's/.*averages*: //')) =="
    node "$LIVENESS_DIR/hand-times.mjs" "$EVENTS" --from "$from" --players "$players"
    echo "ValidatorSlashed during the run: $(ev_count ValidatorSlashed "$INITIAL_HEIGHT" "$(ev_scanned)")"
  } >"$NET/timing.txt"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${KEEP:-}" == 1 ]]; then
    echo "KEEP=1: processes and homes are left in $WORK"
  else
    local pid
    for pid in ${RUN_PIDS:-}; do kill "$pid" 2>/dev/null || true; done
    stop_all
    rm -rf "$WORK"/*/node[0-9] "$WORK"/*/state
  fi
  exit "$status"
}

stop_all
rm -rf "$WORK"
mkdir -p "$WORK" "$PIDS" "$CACHE"
trap cleanup EXIT
trap 'exit 130' INT TERM

OCPD="$(build_ocpd)"
[[ "${SKIP_BUILD:-}" == 1 ]] || build_new
say "chain binary $OCPD ($(ocpd_origin)); networks: $CONFIGS; $HANDS hands each"

index=0
RUN_PIDS=""
for config in $CONFIGS; do
  (
    BLOCK_SECONDS="${config#*:}"
    net_use "${config%%:*}p-${BLOCK_SECONDS}s" "$index"
    time_hands "${config%%:*}"
    say "finished"
  ) >"$WORK/${config/:/p-}s.log" 2>&1 &
  RUN_PIDS="$RUN_PIDS $!"
  index=$((index + 1))
done
wait || true

status=0
for config in $CONFIGS; do
  if ! cat "$WORK/${config%%:*}p-${config#*:}s/timing.txt" 2>/dev/null; then
    echo "== ${config%%:*} players, ${config#*:} s blocks: NOT MEASURED, see $WORK/${config/:/p-}s.log =="
    status=1
  fi
  echo
done
exit "$status"
