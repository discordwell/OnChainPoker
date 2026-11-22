#!/usr/bin/env bash
# Proves on local three-validator networks that dealing recovers by itself: transactions are
# confirmed with the tx index off, and the dealer daemons replace an epoch that cannot deal.
# The chain binary is built from the code the live validators run (CHAIN_REF), the chain id is a
# production one, the first height is 1,100,000, and every node runs with indexer = "null".
#
#   bash scripts/liveness-repro.sh                    every scenario, 5 s blocks, about 2 hours
#   BLOCK_SECONDS=1 bash scripts/liveness-repro.sh    1 s blocks, about 40 minutes
#   ONLY="main kill9" bash scripts/liveness-repro.sh  some scenarios
#   JOBS=1 ...        one network at a time (default: all at once, each on its own ports)
#   KEEP=1 ...        leave the processes, homes and logs in .tmp/liveness for inspection
#   CHAIN_REF=HEAD    another chain build; OCPD_BIN=path uses a binary as it is
#
# Every check prints one line:
#   CHECK <id> <what was measured>: <observed> (want <expected>) PASS|FAIL
# and the run ends with the table of all of them and
#   checks expected 34, ran 34, passed 34
# It exits 0 only when the three numbers are equal. Processes and chain homes are removed on exit;
# logs stay in .tmp/liveness until the next run.
#
# Scenarios (each on a fresh network) and the checks they hold. Numbers 01 to 24 are the design's;
# 11, 21 and 24 are not run (see checks_of), 25 to 37 are new.
#   main        the tx index is off and transactions confirm; a fresh chain reaches a dealing epoch
#               with encrypted shares only; the live chain's dead-epoch state, the old daemons'
#               two failures in it, and the new daemons rotating out of it with nothing typed
#   kill9       daemons killed around their key-generation commit come back with the same secrets;
#               the finalized key generation is readable at past heights
#   fallback    one share never lands: one complaint, one plaintext reveal, nobody slashed
#   absent      one daemon never starts: no epoch and no slash while patience lasts, then the
#               others begin without it; a jailed validator is unjailed only through its own node
#   unrevealed  a validator that committed to the beacon and never revealed is slashed by
#               BeginEpoch and left out of the committee

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/liveness/lib.sh"

SCENARIOS="main kill9 fallback absent unrevealed"

# The checks each scenario must report. A check with no row at the end counts as not run.
# Not run from the design's list: 11 (it measured the old daemons failing to deal a hand; here the
# dead epoch is made by stopping the daemons), 21 and 24 (a second self-unjail on one chain: the
# daemon waits an hour between unjails by design, which 27 checks; their dealing half is 18 to 20).
checks_of() {
  case "$1" in
    main) echo "33 01 02 25 03 04 05 06 36 07 08 10 12 26 13 09 14 15 34 16 17 18 19 20" ;;
    kill9) echo "23 37" ;;
    fallback) echo "29" ;;
    absent) echo "22 30 31 35 28 27" ;;
    unrevealed) echo "32" ;;
  esac
}

# How far a rotation may be from its start: one beacon window, the DKG's 240 blocks, and room for
# one window that closed short.
ROTATION_BLOCKS=560
# 120 s of dealer deadline in blocks, with room.
DEADLINE_BLOCKS=$((180 / BLOCK_SECONDS + 40))
# A hand from start to showdown, in blocks, with room: three shuffle proofs dominate it.
HAND_BLOCKS=$((400 / BLOCK_SECONDS + 150))

short() { echo "${1:0:15}"; } # the daemon prints a validator as its first 15 characters

start_daemons() { local i; for i in 0 1 2; do daemon_start "$i" "$@"; done; }
stop_daemons()  { local i; for i in 0 1 2; do daemon_stop "$i" "${1:-TERM}"; done; }

# ev_wait_n TYPE FROM N BLOCKS [text ...]: waits for the Nth such event and prints it.
ev_wait_n() {
  local type="$1" from="$2" n="$3" blocks="$4"
  shift 4
  while (($(ev_count "$type" "$from" 999999999 "$@") < n)); do
    (($(ev_scanned) <= from + blocks)) || return 1
    ev_sync $(($(ev_scanned) + 1))
  done
  ev_list "$type" "$from" 999999999 "$@" | sed -n "${n}p"
}

# hands_check ID FROM WHAT: three hands dealt and one played to showdown after FROM.
hands_check() {
  local id="$1" from="$2" what="$3" ready completed verdict=FAIL
  ev_wait_n HoleCardsReady "$from" 3 $((3 * HAND_BLOCKS)) >/dev/null || true
  ev_wait HandCompleted "$from" $((3 * HAND_BLOCKS)) reason=showdown >/dev/null || true
  ready="$(ev_count HoleCardsReady "$from" 999999999)"
  completed="$(ev_count HandCompleted "$from" 999999999 reason=showdown)"
  if ((ready >= 3 && completed >= 1)); then verdict=PASS; fi
  check "$id" "$what" "at least 3 HoleCardsReady, 1 hand completed at showdown" "$ready HoleCardsReady, $completed completed at showdown" "$verdict"
}

# ---------------------------------------------------------------------------------------------

scenario_main() {
  net_init 2 quiet
  # The probe's sender: a key nothing else spends from.
  local probe_key probe_addr
  probe_key="$(openssl rand -hex 32)"
  ocpd keys import-hex probe "$probe_key" --home "$NET/node0" --keyring-backend test >/dev/null 2>&1
  probe_addr="$(ocpd keys show probe -a --home "$NET/node0" --keyring-backend test)"
  net_start
  local h0="$INITIAL_HEIGHT" line i n

  # ---- the network is the live chain's kind ----
  line="$(ev_wait BeaconOpened "$h0" 5)" || die "no BeaconOpened at the first block"
  local open close reveal
  open="$(ev_attr "$line" commitOpenHeight)"; close="$(ev_attr "$line" commitCloseHeight)"; reveal="$(ev_attr "$line" revealCloseHeight)"
  check_is 33 "the chain's first beacon window: first height, commit blocks, reveal blocks" "$INITIAL_HEIGHT 50 50" "$open $((close - open)) $((reveal - close))"

  local landed lookup
  landed="$(cli_tx 0 faucet bank send faucet "$probe_addr" "1000000$DENOM")"
  lookup="HTTP $(curl -s -o "$NET/lcd-tx.json" -w '%{http_code}' "$(lcd_url 0)/cosmos/tx/v1beta1/txs/$(cat "$NET/last-tx")") $(jq -r '.message' "$NET/lcd-tx.json")"
  check_is 01 "LCD lookup by hash of a transaction that is in a block" "HTTP 500 transaction indexing is disabled" "$lookup"
  if [[ "$landed" =~ ^[0-9]+\ code=0$ && "${landed%% *}" -gt "$INITIAL_HEIGHT" ]]; then check 02 "the same transaction, found by reading blocks" "a height above $INITIAL_HEIGHT, code=0" "$landed" PASS
  else check 02 "the same transaction, found by reading blocks" "a height above $INITIAL_HEIGHT, code=0" "$landed" FAIL; fi

  OCP_PROBE_PRIVKEY="$probe_key" node "$ROOT/scripts/tx-confirm-probe.mjs" --rpc "$(rpc_url 0)" --quiet-rpc "$(rpc_url 3)" >"$NET/logs/probe.txt" 2>&1 || true
  check_is 25 "tx-confirm-probe.mjs through a validator and through a node that does not relay" "checks ran 7, passed 7, failed 0" "$(tail -n 1 "$NET/logs/probe.txt")"

  # ---- a fresh chain reaches a dealing epoch, nothing typed ----
  start_daemons
  bot_start 0; bot_start 1
  local fin fin_h begun
  fin="$(ev_wait DealerEpochFinalized "$h0" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not finalized in $ROTATION_BLOCKS blocks"
  fin_h="${fin%% *}"
  begun="$(ev_list DealerEpochBegun "$h0" "$fin_h" | sed -n 1p)"
  local start_h commit_dl complaint_dl reveal_dl senders
  start_h="$(ev_attr "$begun" startHeight)"; commit_dl="$(ev_attr "$begun" commitDeadline)"
  complaint_dl="$(ev_attr "$begun" complaintDeadline)"; reveal_dl="$(ev_attr "$begun" revealDeadline)"
  senders="$(grep -l 'Rotation: begin epoch 1 (committee 3, threshold 2, windows 120/60/60/60) landed' "$NET"/logs/dealer-?.log | grep -c . || true)"
  check_is 03 "DealerEpochBegun events, daemons that sent one, its windows in blocks" "1 event, 1 daemon, 120/60/60" \
    "$(ev_count DealerEpochBegun "$h0" "$fin_h") event, $senders daemon, $((commit_dl - start_h))/$((complaint_dl - commit_dl))/$((reveal_dl - complaint_dl))"
  check_is 04 "DealerEpochFinalized for epoch 1" "committeeSize=3 slashed=0" "committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed)"
  n=0
  for i in 0 1 2; do log_wait "$(daemon_log $i)" 20 'share for epoch 1 matches my on-chain pub_share' && n=$((n + 1)); done
  check_is 05 "daemons whose share for epoch 1 matches their on-chain pub_share" 3 "$n"
  check_is 06 "key generation 1: commits, encrypted shares, complaints, plaintext reveals" "3 6 0 0" \
    "$(ev_count DKGCommitAccepted "$h0" "$fin_h") $(ev_count DKGEncryptedShareAccepted "$h0" "$fin_h") $(ev_count DKGComplaintAccepted "$h0" "$fin_h") $(ev_count DKGShareRevealed "$h0" "$fin_h")"
  check_is 36 "rotation transactions of the three daemons that the node refused or a block failed, from the first block to the finalize" 0 \
    "$(cat "$NET"/logs/dealer-?.log | grep -Ec 'Rotation: .* (rejected|failed|expired|unknown): ' || true)"
  hands_check 07 "$fin_h" "hands on epoch 1"
  check_is 08 "ValidatorSlashed since the first block" 0 "$(ev_count ValidatorSlashed "$h0" "$(ev_scanned)")"

  # ---- the live chain's dead-epoch state, by the cheapest honest route ----
  # What the 120 s stall did to hand 15164: no daemon delivered its hole-card shares. The daemons
  # send those shares into the block that makes the deck final, so killing them at DeckFinalized is
  # too late: each one reaches its node through a proxy that loses them.
  local deck hand from i port
  for i in 0 1 2; do
    port=$((BASE_PORT + NET_INDEX * 100 + 91 + i))
    node "$LIVENESS_DIR/drop-tx-proxy.mjs" --listen "$port" --upstream "$(rpc_url "$i")" \
      --type /onchainpoker.dealer.v1.MsgSubmitEncShare >"$NET/logs/proxy-$i.log" 2>&1 &
    echo $! >"$PIDS/$NET_NAME.proxy$i"
    daemon_stop "$i"
    daemon_start "$i" "DEALER_COSMOS_RPC_URL=http://127.0.0.1:$port"
  done
  from="$(ev_scanned)"
  deck="$(ev_wait DeckFinalized $((from + 2)) "$HAND_BLOCKS")" || die "no hand reached DeckFinalized"
  stop_daemons KILL
  for i in 0 1 2; do proc_stop "proxy$i"; done
  hand="$(ev_attr "$deck" handId)"
  say "hole-card shares lost and daemons killed at DeckFinalized of hand $hand; waiting out the 120 s dealer deadline"
  wait_chain_seconds 125
  cli_tx 0 faucet dealer timeout --table-id 1 --hand-id "$hand" >/dev/null
  ev_sync "$(chain_height)"
  check_is 10 "ValidatorSlashed for hole-enc-shares-timeout after the daemons were killed in hand $hand (caused by this script)" 3 \
    "$(ev_count ValidatorSlashed "${deck%% *}" "$(ev_scanned)" reason=hole-enc-shares-timeout)"
  check_is 12 "epoch 1: members, and members not slashed (threshold 2)" "3 0" \
    "$(ocpq dealer epoch | jq -r '.epoch | "\(.members | length) \((.members | length) - (.slashed | length))"')"

  # What the operator typed in May: unjail, then begin-epoch with the chain's default windows and
  # dkg-timeout, both by hand. The roll call before it is the rollout's rehearsal: BeginEpoch off.
  wait_chain_seconds 61
  for i in 0 1 2; do
    [[ "$(is_jailed $i)" != true ]] || cli_tx "$i" validator slashing unjail >/dev/null
  done
  local rehearsal
  rehearsal="$(chain_height)"
  start_daemons DEALER_AUTO_BEGIN_EPOCH=false
  n=0
  for i in 0 1 2; do
    log_wait "$(daemon_log $i)" 260 'beacon for epoch 2 has 3 reveals; BeginEpoch is disabled on this daemon' && n=$((n + 1))
  done
  wait_blocks 10
  ev_sync "$(chain_height)"
  local window
  # A window with 3 reveals is never replaced, so the last one opened is the one the roll call used.
  window="$(ev_list BeaconOpened "$h0" 999999999 epochId=2 | tail -n 1)"
  check_is 26 "roll call with DEALER_AUTO_BEGIN_EPOCH=false: daemons holding with 3 reveals, commits, reveals, DealerEpochBegun, ValidatorSlashed" "3 3 3 0 0" \
    "$n $(ev_count BeaconCommitted "${window%% *}" 999999999 epochId=2) $(ev_count BeaconRevealed "${window%% *}" 999999999 epochId=2) $(ev_count DealerEpochBegun "$rehearsal" 999999999) $(ev_count ValidatorSlashed "$rehearsal" 999999999)"
  stop_daemons
  local typed
  typed="$(chain_height)"
  cli_tx 0 validator dealer begin-epoch --committee-size 3 --threshold 2 >/dev/null
  begun="$(ev_wait DealerEpochBegun "$typed" 40 epochId=2)" || die "the begin-epoch typed by hand did not begin epoch 2"
  wait_height $(($(ev_attr "$begun" commitDeadline) + 1))
  cli_tx 0 validator dealer dkg-timeout --epoch-id 2 >/dev/null
  ev_sync "$(chain_height)"
  check_is 13 "after begin-epoch and dkg-timeout by hand: DealerEpochAborted for epoch 2, the store's next epoch id, the epoch in force" "1 3 1" \
    "$(ev_count DealerEpochAborted "$rehearsal" 999999999 epochId=2) $(next_epoch_id) $(ocpq dealer epoch | jq -r '.epoch.epoch_id')"

  # ---- the old daemons in that state ----
  local old_from old_log
  old_from="$(chain_height)"
  for i in 0 1 2; do daemon_start_old "$i"; done
  old_log="$NET/logs/old-dealers.txt"
  # A stalled daemon reports 120 s after its transaction landed, whatever the block time.
  for ((n = 0; n < 2 * DEADLINE_BLOCKS; n++)); do
    cat "$NET"/logs/old-dealer-?.log >"$old_log"
    if log_has "$old_log" 'timed out waiting for tx .* via LCD \(unexpected HTTP 500 from LCD tx query\)' && log_has "$old_log" 'epoch_id mismatch'; then break; fi
    wait_blocks 2
  done
  wait_height $((old_from + 110)) # one whole beacon window, in which a daemon that could begin would
  ev_sync "$(chain_height)"
  for i in 0 1 2; do proc_stop "old-dealer-$i"; done
  cat "$NET"/logs/old-dealer-?.log >"$old_log"
  line="$(grep -Eo 'timed out waiting for tx [0-9A-F]+ via LCD \(unexpected HTTP 500 from LCD tx query\)' "$old_log" | sed -n 1p || true)"
  if [[ -n "$line" ]]; then check 09 "an old daemon, after a transaction of its own landed" "timed out waiting for tx ... via LCD (unexpected HTTP 500 from LCD tx query)" "${line/ [0-9A-F]* via/ ... via}" PASS
  else check 09 "an old daemon, after a transaction of its own landed" "timed out waiting for tx ... via LCD (unexpected HTTP 500 from LCD tx query)" "no such line" FAIL; fi
  line="$(grep -Eo 'commit error for epoch [0-9]+.*epoch_id mismatch' "$old_log" | sed -n 1p | sed -E 's/(commit error for epoch [0-9]+).*(epoch_id mismatch).*/\1: \2/' || true)"
  check_is 14 "an old daemon's beacon commit while the chain waits for epoch 3" "commit error for epoch 2: epoch_id mismatch" "${line:-no such line}"
  check_is 15 "DealerEpochBegun in the $(($(chain_height) - old_from)) blocks the old daemons ran" 0 "$(ev_count DealerEpochBegun "$old_from" 999999999)"

  # ---- the new daemons in that state, nothing typed ----
  wait_blocks 3 # what the old daemons had in a mempool lands
  local explained=0 sequences
  sequences="$(for i in 0 1 2; do account_sequence "$i"; done | tr '\n' ' ')"
  for i in 0 1 2; do
    daemon_explain "$i" >"$NET/logs/explain-$i.txt"
    if log_has "$NET/logs/explain-$i.txt" 'epoch 1 cannot deal \(0 of 3 members qualified, need 2\)\. Next epoch is 3\.' \
      && log_has "$NET/logs/explain-$i.txt" 'Explain: nothing was sent' && ! log_has "$NET/logs/explain-$i.txt" 'epoch 2([^0-9]|$)'; then
      explained=$((explained + 1))
    fi
  done
  wait_blocks 3
  check_is 34 "--explain on the dead epoch: daemons that say epoch 1 cannot deal, 3 is next and nothing was sent; the validators' account sequences after" "3; $sequences" \
    "$explained; $(for i in 0 1 2; do account_sequence "$i"; done | tr '\n' ' ')"

  local swap jailed="" unjailed=0
  for i in 0 1 2; do [[ "$(is_jailed $i)" != true ]] || jailed="$jailed $i"; done
  swap="$(chain_height)"
  say "new daemons start at height $swap; jailed validators:$jailed"
  start_daemons
  for i in $jailed; do log_wait "$(daemon_log $i)" 200 'Unjail: .* unjailed \(attempt 1' && unjailed=$((unjailed + 1)); done
  wait_blocks 3
  check_is 16 "validators jailed by the dkg-timeout, those unjailed by their own daemon; then bonded, jailed" "2 2; 3 0" \
    "$(wc -w <<<"$jailed" | tr -d ' ') $unjailed; $(bonded_count) $(jailed_count)"
  fin="$(ev_wait DealerEpochFinalized "$swap" "$ROTATION_BLOCKS" epochId=3)" || die "epoch 3 was not finalized in $ROTATION_BLOCKS blocks"
  fin_h="${fin%% *}"
  n=0
  for i in 0 1 2; do n=$((n + $(grep -Ec 'epoch 2([^0-9]|$)' "$(since_start "$(daemon_log $i)")" || true))); done
  check_is 17 "beacon commits for epoch 3 and for epoch 2 since the swap; daemon lines that name epoch 2" "at least 3, 0; 0" \
    "$( (($(ev_count BeaconCommitted "$swap" "$fin_h" epochId=3) >= 3)) && echo "at least 3" || ev_count BeaconCommitted "$swap" "$fin_h" epochId=3), $(ev_count BeaconCommitted "$swap" "$fin_h" epochId=2); $n"
  check_is 18 "DealerEpochFinalized for epoch 3" "committeeSize=3 slashed=0" "committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed)"
  hands_check 19 "$fin_h" "hands on epoch 3"
  check_is 20 "ValidatorSlashed since the new daemons started" 0 "$(ev_count ValidatorSlashed "$swap" "$(ev_scanned)")"
}

scenario_kill9() {
  net_init 2
  net_start
  start_daemons
  bot_start 0; bot_start 1
  # One daemon is killed once its secrets are on disk (its commit is being sent), one right after its commit landed.
  local a="${ORDER[0]}" b="${ORDER[1]}" killed_a="" killed_b="" begun fin limit
  begun="$(ev_wait DealerEpochBegun "$INITIAL_HEIGHT" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not begun"
  limit=$(($(ev_attr "$begun" commitDeadline) - 30))
  while [[ -z "$killed_a" || -z "$killed_b" ]]; do
    if [[ -z "$killed_a" ]] && log_has "$(daemon_log $a)" 'DKG: secrets for epoch 1 written to disk'; then daemon_stop "$a" KILL; killed_a="$(chain_height)"; fi
    if [[ -z "$killed_b" ]] && log_has "$(daemon_log $b)" 'Rotation: dkg commit for epoch 1 landed'; then daemon_stop "$b" KILL; killed_b="$(chain_height)"; fi
    (($(chain_height) < limit)) || die "the daemons did not reach their commits"
    sleep 0.05
  done
  local sent_a=no; log_has "$(daemon_log $a)" 'Rotation: dkg commit for epoch 1 landed' && sent_a=yes
  say "killed daemon $a at $killed_a (its commit had landed: $sent_a) and daemon $b at $killed_b"
  wait_chain_seconds 20
  daemon_start "$a"; daemon_start "$b"
  fin="$(ev_wait DealerEpochFinalized "$INITIAL_HEIGHT" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not finalized"
  ev_wait HandCompleted "${fin%% *}" "$((2 * HAND_BLOCKS))" reason=showdown >/dev/null || true
  local i written=0 matches=0 commits=0 settled=0
  for i in "$a" "$b"; do
    written=$((written + $(grep -c 'DKG: secrets for epoch 1 written to disk' "$(daemon_log $i)" || true)))
    ! log_has "$(since_start "$(daemon_log $i)")" 'DKG: my commit for epoch 1 is on chain and matches the secrets on disk' || matches=$((matches + 1))
    ! log_has "$(since_start "$(daemon_log $i)")" 'share for epoch 1 matches my on-chain pub_share \(3 qualified dealers\)' || settled=$((settled + 1))
    commits=$((commits + $(ev_count DKGCommitAccepted "$INITIAL_HEIGHT" "${fin%% *}" "dealer=${VALOPER[$i]}")))
  done
  log_has "$(since_start "$(daemon_log $a)")" 'Rotation: dkg commit for epoch 1 landed' && say "daemon $a sent its commit again after the restart, and the chain took it"
  check_is 37 "the finalized DKG read at past heights, as a daemon that was down at the finalize reads it: commits and encrypted shares at its reveal deadline; reads at heights the node does not hold that were refused" "3 6; 2 of 2" \
    "$(node "$LIVENESS_DIR/past-state-probe.mjs" --rpc "$(rpc_url 0)" 2>&1 | tail -n 1)"
  check_is 23 "two daemons killed -9, one as its commit was sent and one after it landed, restarted 20 s later: commits on chain from them, times they wrote secrets, restarts that found the chain's commit equal to the disk's, restarts whose share matches the chain; the epoch; slashes; hands completed at showdown" \
    "2 2 2 2; committeeSize=3 slashed=0; 0; at least 1" \
    "$commits $written $matches $settled; committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed); $(ev_count ValidatorSlashed "$INITIAL_HEIGHT" "$(ev_scanned)"); $( (($(ev_count HandCompleted "${fin%% *}" 999999999 reason=showdown) >= 1)) && echo "at least 1" || echo 0)"
}

scenario_fallback() {
  net_init 2
  net_start
  # The share from the first validator in order to the second (DKG index 2) never lands.
  local dealer="${ORDER[0]}" to="${ORDER[1]}" proxy_port=$((BASE_PORT + NET_INDEX * 100 + 90)) i fin
  node "$LIVENESS_DIR/drop-tx-proxy.mjs" --listen "$proxy_port" --upstream "$(rpc_url "$dealer")" \
    --type /onchainpoker.dealer.v1.MsgDkgEncryptedShare --field 3=2 >"$NET/logs/proxy.log" 2>&1 &
  echo $! >"$PIDS/$NET_NAME.proxy"
  for i in 0 1 2; do
    if [[ "$i" == "$dealer" ]]; then daemon_start "$i" "DEALER_COSMOS_RPC_URL=http://127.0.0.1:$proxy_port"; else daemon_start "$i"; fi
  done
  bot_start 0; bot_start 1
  fin="$(ev_wait DealerEpochFinalized "$INITIAL_HEIGHT" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not finalized"
  local fin_h="${fin%% *}" matched=no
  log_wait "$(daemon_log $to)" 20 'share for epoch 1 matches my on-chain pub_share' && matched=yes
  ev_wait HandCompleted "$fin_h" "$((2 * HAND_BLOCKS))" reason=showdown >/dev/null || true
  check_is 29 "one share lost on the way: shares lost by the proxy; encrypted shares, complaints against that dealer by that member, plaintext reveals; the epoch; slashes; the member's share matches; hands completed at showdown" \
    "lost; 5 1 1; committeeSize=3 slashed=0; 0; yes; at least 1" \
    "$( (($(grep -c ' lost ' "$NET/logs/proxy.log" || true) >= 1)) && echo lost || echo none); $(ev_count DKGEncryptedShareAccepted "$INITIAL_HEIGHT" "$fin_h") $(ev_count DKGComplaintAccepted "$INITIAL_HEIGHT" "$fin_h") $(ev_count DKGShareRevealed "$INITIAL_HEIGHT" "$fin_h"); committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed); $(ev_count ValidatorSlashed "$INITIAL_HEIGHT" "$(ev_scanned)"); $matched; $( (($(ev_count HandCompleted "$fin_h" 999999999 reason=showdown) >= 1)) && echo "at least 1" || echo 0)"
}

scenario_absent() {
  net_init 2
  net_start
  local gone="${ORDER[1]}" i here="" line n
  for i in 0 1 2; do [[ "$i" == "$gone" ]] || here="$here $i"; done
  # A day's patience, as the live rehearsal sets it.
  for i in $here; do daemon_start "$i" DEALER_PATIENCE_BLOCKS=17280; done
  bot_start 0; bot_start 1

  # Four windows pass. The fifth BeaconOpened is the chain replacing the fourth.
  line="$(ev_wait_n BeaconOpened "$INITIAL_HEIGHT" 5 440 epochId=1)" || die "the chain did not open a fifth beacon window"
  local fifth="${line%% *}" told=0
  for i in $here; do log_has "$(daemon_log $i)" "roll call for epoch 1 incomplete: no commit from $(short "${VALOPER[$gone]}")…; not revealing" && told=$((told + 1)); done
  check_is 22 "one daemon never started, patience 17280, four beacon windows: DealerEpochBegun, ValidatorSlashed, daemons that name the absent validator and do not reveal" "0 0 2" \
    "$(ev_count DealerEpochBegun "$INITIAL_HEIGHT" "$fifth") $(ev_count ValidatorSlashed "$INITIAL_HEIGHT" "$fifth") $told"
  # Each window that closed below its threshold is followed by a new one for the same epoch, opened by the chain at the next block.
  n="$(ev_list BeaconOpened "$INITIAL_HEIGHT" "$fifth" epochId=1 | awk '
    { for (i = 4; i <= NF; i++) { split($i, kv, "="); a[kv[1]] = kv[2] } }
    NR > 1 && a["commitOpenHeight"] == prev + 1 && a["origin"] == "auto" { replaced++ }
    { prev = a["revealCloseHeight"] }
    END { print replaced + 0 }')"
  check_is 30 "beacon windows that closed with no reveal and were replaced by the chain at the next block, at heights above $INITIAL_HEIGHT; reveals in them" "4 0" \
    "$n $(ev_count BeaconRevealed "$INITIAL_HEIGHT" "$fifth")"

  # The same two daemons with a small patience.
  for i in $here; do daemon_stop "$i"; daemon_start "$i" DEALER_PATIENCE_BLOCKS=30; done
  local fin fin_h begun announced=0 slashes
  fin="$(ev_wait DealerEpochFinalized "$fifth" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not finalized"
  fin_h="${fin%% *}"
  begun="$(ev_list DealerEpochBegun "$fifth" "$fin_h" | sed -n 1p)"
  for i in $here; do
    ! log_has "$(since_start "$(daemon_log $i)")" "patience ended after [0-9]+ blocks; (revealing without|beginning epoch 1 without) $(short "${VALOPER[$gone]}")…" || announced=$((announced + 1))
  done
  slashes="$(ev_list ValidatorSlashed "$INITIAL_HEIGHT" "$fin_h" | sed -E 's/.* validator=([^ ]+) reason=([^ ]+).*/\1 \2/')"
  check_is 31 "patience 30: daemons that announce it; the committee begun; who the chain slashed and why; the epoch" \
    "2; committeeSize=3; ${VALOPER[$gone]} dkg-missing-commit; committeeSize=3 slashed=1" \
    "$announced; committeeSize=$(ev_attr "$begun" committeeSize); $slashes; committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed)"
  hands_check 35 "$fin_h" "hands dealt by the two validators that are left"

  # The slashed validator is jailed for 60 s. Its daemon unjails it only through its own node.
  wait_chain_seconds 61
  local other="${here:1:1}" refused=no still unjailed=no
  daemon_start "$gone" "DEALER_COSMOS_RPC_URL=$(rpc_url "$other")" "DEALER_COSMOS_LCD_URL=$(lcd_url "$other")"
  log_wait "$(daemon_log $gone)" 40 "Not unjailing: this daemon's node does not sign with this validator's consensus key" && refused=yes
  wait_blocks 20
  still="$(is_jailed "$gone")"
  daemon_stop "$gone"
  daemon_start "$gone"
  log_wait "$(daemon_log $gone)" 60 'Unjail: .* unjailed \(attempt 1' && unjailed=yes
  wait_blocks 3
  check_is 28 "a jailed validator's daemon on another validator's node: refuses, still jailed 20 blocks on; on its own node: unjails; then bonded, jailed" "yes true; yes; 3 0" \
    "$refused $still; $unjailed; $(bonded_count) $(jailed_count)"

  # A second jail within the hour: the validator's node goes down for a signing window and the
  # chain jails it for downtime. Its daemon leaves it jailed, as it would in a crash loop.
  local waits=no rebonded
  rebonded="$(chain_height)"
  daemon_stop "$gone"
  node_stop "$gone"
  say "node $gone is down until the chain jails its validator for missed blocks"
  for ((n = 0; n < 160; n++)); do
    [[ "$(is_jailed "$gone")" != true ]] || break
    wait_blocks 2
  done
  node_start "$gone"
  daemon_start "$gone"
  log_wait "$(daemon_log $gone)" 60 'Not unjailing: 1 unjail landed lately, so the next one waits [0-9]+ more minutes' && waits=yes
  wait_blocks 10
  check_is 27 "a validator jailed again within the hour (its node was down $(($(chain_height) - rebonded)) blocks), its daemon restarted: says it waits; still jailed" "yes true" "$waits $(is_jailed "$gone")"
}

scenario_unrevealed() {
  net_init 2
  net_start
  local last="${ORDER[2]}" begun fin members
  start_daemons DEALER_PATIENCE_BLOCKS=30
  bot_start 0; bot_start 1
  # The last validator in order reveals last. Its daemon dies between its commit and its reveal.
  log_wait "$(daemon_log $last)" 70 'Rotation: beacon commit for epoch 1 landed' || die "daemon $last did not commit to the beacon"
  daemon_stop "$last" KILL
  begun="$(ev_wait DealerEpochBegun "$INITIAL_HEIGHT" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not begun"
  fin="$(ev_wait DealerEpochFinalized "$INITIAL_HEIGHT" "$ROTATION_BLOCKS" epochId=1)" || die "epoch 1 was not finalized"
  ev_wait HandCompleted "${fin%% *}" "$((2 * HAND_BLOCKS))" reason=showdown >/dev/null || true
  members="$(ocpq dealer epoch | jq -r --arg v "${VALOPER[$last]}" '.epoch.members | "\(length) members, \([.[] | select(.validator == $v)] | length) of them the unrevealed one"')"
  check_is 32 "a validator that committed to the beacon and never revealed: who BeginEpoch slashed and why, at which height; the committee; the epoch; hands completed at showdown" \
    "${VALOPER[$last]} beacon-missing-reveal at the begin height; committeeSize=2; 2 members, 0 of them the unrevealed one; committeeSize=2 slashed=0; at least 1" \
    "$(ev_list ValidatorSlashed "$INITIAL_HEIGHT" "$(ev_scanned)" | awk -v b="${begun%% *}" '{ at = ($1 == b) ? "at the begin height" : "at height " $1; for (i = 4; i <= NF; i++) { split($i, kv, "="); a[kv[1]] = kv[2] } printf "%s %s %s", a["validator"], a["reason"], at }'); committeeSize=$(ev_attr "$begun" committeeSize); $members; committeeSize=$(ev_attr "$fin" committeeSize) slashed=$(ev_attr "$fin" slashed); $( (($(ev_count HandCompleted "${fin%% *}" 999999999 reason=showdown) >= 1)) && echo "at least 1" || echo 0)"
}

# ---------------------------------------------------------------------------------------------

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${KEEP:-}" == 1 ]]; then
    echo "KEEP=1: processes, homes and logs are left in $WORK"
  else
    local pid
    for pid in ${SCENARIO_PIDS:-}; do kill "$pid" 2>/dev/null || true; done
    stop_all
    rm -rf "$WORK"/*/node[0-9] "$WORK"/*/state
  fi
  exit "$status"
}

main() {
  local selected="${ONLY:-$SCENARIOS}" name index=0 free_gb

  free_gb="$(df -k "$ROOT" | awk 'NR == 2 { print int($4 / 1048576) }')"
  ((free_gb >= 2)) || die "$free_gb GB free on the disk; this run wants 2"

  # A previous run that was cut off left its pid files: stop what they name, then start clean.
  stop_all
  rm -rf "$WORK"
  mkdir -p "$WORK" "$PIDS" "$CACHE"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  OCPD="$(build_ocpd)"
  [[ "${SKIP_BUILD:-}" == 1 ]] || build_new
  OLD_TREE=""
  [[ " $selected " != *" main "* ]] || OLD_TREE="$(build_old)"
  say "chain binary $OCPD ($(ocpd_origin)), ${BLOCK_SECONDS} s blocks, scenarios: $selected"

  exec 3>&1
  SCENARIO_PIDS=""
  for name in $SCENARIOS; do
    if [[ " $selected " == *" $name "* ]]; then
      (
        net_use "$name" "$index"
        "scenario_$name"
        say "scenario finished"
      ) >"$WORK/$name.log" 2>&1 &
      SCENARIO_PIDS="$SCENARIO_PIDS $!"
      while (($(jobs -pr | wc -l) >= ${JOBS:-5})); do sleep 2; done
    fi
    index=$((index + 1))
  done
  wait || true

  local id expected=0 ran=0 passed=0 row
  : >"$WORK/summary.txt"
  for name in $selected; do
    for id in $(checks_of "$name"); do
      expected=$((expected + 1))
      row="$(awk -F '\t' -v id="$id" '$1 == id' "$WORK/$name/checks.tsv" 2>/dev/null | tail -n 1)"
      if [[ -z "$row" ]]; then
        echo "CHECK $id NOT RUN | scenario $name stopped before it: $WORK/$name.log" >>"$WORK/summary.txt"
        continue
      fi
      ran=$((ran + 1))
      [[ "$(cut -f 5 <<<"$row")" != PASS ]] || passed=$((passed + 1))
      awk -F '\t' '{ printf "CHECK %s %s | %s | want: %s | observed: %s\n", $1, $5, $2, $3, $4 }' <<<"$row" >>"$WORK/summary.txt"
    done
  done
  echo
  echo "== checks =="
  sort -k 2,2 "$WORK/summary.txt"
  echo "checks expected $expected, ran $ran, passed $passed"
  ((expected == ran && ran == passed))
}

main "$@"
