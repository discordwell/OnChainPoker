# Sourced by scripts/liveness-repro.sh and scripts/hand-timing.sh. One local network of three
# validators with the live chain's settings, its dealer daemons and players, waits counted in
# blocks, and the CHECK lines.
#
# Every wait is bounded in blocks, not seconds: the machine may be loaded and block time stretches.
# A chain that makes no block for STALL_SECS is the one wall-clock failure.

LIVENESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$LIVENESS_DIR/../.." && pwd)"

WORK="${WORK:-$ROOT/.tmp/liveness}"
CACHE="${CACHE:-$ROOT/.tmp/liveness-cache}"
# The chain code the live validators run: the last chain commit before their 2026-05-20 build.
CHAIN_REF="${CHAIN_REF:-522f49c}"
# The daemon, bot and SDK from before both repairs.
OLD_REF="${OLD_REF:-e72f229}"
BLOCK_SECONDS="${BLOCK_SECONDS:-5}"
# Not a devnet id (x/dealer/committee/beacon.go), so the beacon windows are 50 + 50 blocks and
# BeginEpoch needs a revealed beacon, as on the live chain.
CHAIN_ID="ocp-proofnet-1"
# Above 1,036,000, where the chain starts replacing a beacon window that closed short.
INITIAL_HEIGHT=1100000
BASE_PORT="${BASE_PORT:-41000}"
STALL_SECS="${STALL_SECS:-300}"
DENOM=uchips
# The live daemons' setting. The code default is 26.
SHUFFLE_ROUNDS=16

PIDS="$WORK/pids"

say() { echo "[$(date +%H:%M:%S)]${NET_NAME:+ [$NET_NAME]} $*"; }
die() { say "FATAL: $*" >&2; exit 1; }

# ---- builds --------------------------------------------------------------------------------

# Prints the path of ocpd built from CHAIN_REF, building it once under $CACHE. The working tree
# is not touched: the Go code is extracted from git.
build_ocpd() {
  if [[ -n "${OCPD_BIN:-}" ]]; then echo "$OCPD_BIN"; return; fi
  local sha dir
  sha="$(git -C "$ROOT" rev-parse --short=12 "$CHAIN_REF")" || die "unknown CHAIN_REF $CHAIN_REF"
  dir="$CACHE/chain-$sha"
  if [[ ! -x "$dir/ocpd" ]]; then
    say "building ocpd from $CHAIN_REF ($sha)" >&2
    rm -rf "$dir" && mkdir -p "$dir/src"
    git -C "$ROOT" archive "$sha" apps/cosmos | tar -x -C "$dir/src"
    (cd "$dir/src/apps/cosmos" && go build -o "$dir/ocpd" ./cmd/ocpd) >&2 || die "ocpd build failed"
    rm -rf "$dir/src"
  fi
  echo "$dir/ocpd"
}

ocpd_origin() { if [[ -n "${OCPD_BIN:-}" ]]; then echo "given as OCPD_BIN"; else echo "built from $CHAIN_REF"; fi; }

build_new() {
  say "building the SDK, the dealer daemon and the bot from the working tree"
  local p
  for p in packages/ocp-crypto packages/ocp-shuffle packages/holdem-eval packages/poker-engine packages/ocp-sdk apps/dealer-daemon apps/bot; do
    pnpm -C "$ROOT/$p" build >"$WORK/build-$(basename "$p").log" 2>&1 || die "build of $p failed: $WORK/build-$(basename "$p").log"
  done
}

# Prints the root of OLD_REF's tree with the daemon and the bot built, building it once under $CACHE.
build_old() {
  local sha dir p
  sha="$(git -C "$ROOT" rev-parse --short=12 "$OLD_REF")" || die "unknown OLD_REF $OLD_REF"
  dir="$CACHE/old-$sha"
  if [[ ! -f "$dir/.built" ]]; then
    say "building the daemon and the bot from $OLD_REF ($sha)" >&2
    rm -rf "$dir" && mkdir -p "$dir"
    git -C "$ROOT" archive "$sha" -- package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/dealer-daemon apps/bot | tar -x -C "$dir"
    (cd "$dir" && pnpm install --offline --frozen-lockfile) >"$dir/install.log" 2>&1 || die "old tree install failed: $dir/install.log"
    for p in packages/ocp-crypto packages/ocp-shuffle packages/holdem-eval packages/poker-engine packages/ocp-sdk apps/dealer-daemon apps/bot; do
      pnpm -C "$dir/$p" build >>"$dir/build.log" 2>&1 || die "old tree build of $p failed: $dir/build.log"
    done
    touch "$dir/.built"
  fi
  echo "$dir"
}

# ---- one network ---------------------------------------------------------------------------

# net_use NAME INDEX: every function below acts on this network.
net_use() {
  NET_NAME="$1"
  NET_INDEX="$2"
  NET="$WORK/$NET_NAME"
  EVENTS="$NET/events.log"
  CHECKS="$NET/checks.tsv"
}

rpc_port()  { echo $((BASE_PORT + NET_INDEX * 100 + $1 * 10 + 7)); }
p2p_port()  { echo $((BASE_PORT + NET_INDEX * 100 + $1 * 10 + 6)); }
api_port()  { echo $((BASE_PORT + NET_INDEX * 100 + $1 * 10 + 1)); }
grpc_port() { echo $((BASE_PORT + NET_INDEX * 100 + $1 * 10 + 9)); }
rpc_url()   { echo "http://127.0.0.1:$(rpc_port "$1")"; }
lcd_url()   { echo "http://127.0.0.1:$(api_port "$1")"; }

ocpd() { "$OCPD" "$@"; }
# Queries and transactions go through node 0.
ocpq() { "$OCPD" query "$@" --node "tcp://127.0.0.1:$(rpc_port 0)" --output json; }

set_toml() { # file key value: replaces the first `key = ...` line
  sed -i.bak -E "s|^$2 = .*|$2 = $3|" "$1" && rm -f "$1.bak"
}

configure_node() { # index peers
  local home="$NET/node$1" cfg app
  cfg="$home/config/config.toml"
  app="$home/config/app.toml"
  set_toml "$cfg" indexer '"null"'
  set_toml "$cfg" discard_abci_responses false
  set_toml "$cfg" timeout_commit "\"${NET_BLOCK_SECONDS:-$BLOCK_SECONDS}s\""
  set_toml "$cfg" persistent_peers "\"$2\""
  set_toml "$cfg" pex false
  set_toml "$cfg" addr_book_strict false
  set_toml "$cfg" allow_duplicate_ip true
  set_toml "$app" minimum-gas-prices "\"0$DENOM\""
  # Small homes: no snapshots, and state older than any read this run makes is dropped.
  set_toml "$app" pruning '"custom"'
  set_toml "$app" pruning-keep-recent '"3000"'
  set_toml "$app" pruning-interval '"50"'
  set_toml "$app" snapshot-interval 0
}

# net_init PLAYERS [quiet]: homes, keys and genesis for three validators, PLAYERS funded player
# keys, and with "quiet" a fourth node that is no validator and whose mempool does not relay.
net_init() {
  local players="$1" quiet="${2:-}" i ports port
  rm -rf "$NET" && mkdir -p "$NET/logs" "$NET/state" "$PIDS"
  : >"$CHECKS"

  ports="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {sub(/.*:/, "", $9); print $9}' | sort -u)"
  for i in 0 1 2 3; do
    for port in "$(rpc_port $i)" "$(p2p_port $i)" "$(api_port $i)" "$(grpc_port $i)"; do
      if grep -qx "$port" <<<"$ports"; then die "port $port is in use; set BASE_PORT"; fi
    done
  done

  # Not multinet.sh: a chain whose first height is above 1 checks a gentx against its signer's real
  # account number (the SDK only takes 0 at height 0), and multinet.sh signs every gentx with 0.
  local kr=(--keyring-backend test) genesis="$NET/node0/config/genesis.json" log="$NET/logs/genesis.log"
  for i in 0 1 2; do
    ocpd init "val$i" --chain-id "$CHAIN_ID" --home "$NET/node$i" >>"$log" 2>&1 || die "ocpd init failed: $log"
    ocpd keys add validator --home "$NET/node$i" "${kr[@]}" >/dev/null 2>&1
  done
  ocpd keys add faucet --home "$NET/node0" "${kr[@]}" >/dev/null 2>&1

  PLAYER_KEY=() PLAYER_ADDR=()
  for ((i = 0; i < players; i++)); do
    PLAYER_KEY[i]="$(openssl rand -hex 32)"
    ocpd keys import-hex "player$i" "${PLAYER_KEY[i]}" --home "$NET/node0" "${kr[@]}" >/dev/null 2>&1
    PLAYER_ADDR[i]="$(ocpd keys show "player$i" -a --home "$NET/node0" "${kr[@]}")"
  done

  # Accounts are numbered in the order they are added: validator i is account i.
  for i in 0 1 2; do
    ocpd genesis add-genesis-account "$(ocpd keys show validator -a --home "$NET/node$i" "${kr[@]}")" "1000000000$DENOM" --home "$NET/node0" >>"$log" 2>&1
  done
  ocpd genesis add-genesis-account "$(ocpd keys show faucet -a --home "$NET/node0" "${kr[@]}")" "1000000000000$DENOM" --home "$NET/node0" >>"$log" 2>&1
  for ((i = 0; i < players; i++)); do
    ocpd genesis add-genesis-account "${PLAYER_ADDR[i]}" "50000000$DENOM" --home "$NET/node0" >>"$log" 2>&1
  done
  mkdir -p "$NET/node0/config/gentx"
  for i in 0 1 2; do
    [[ $i == 0 ]] || cp "$genesis" "$NET/node$i/config/genesis.json"
    # A stake that several 50% penalties leave above the one unit of power a validator needs.
    ocpd genesis gentx validator "900000000$DENOM" --chain-id "$CHAIN_ID" --home "$NET/node$i" "${kr[@]}" \
      --moniker "val$i" --offline --account-number "$i" --sequence 0 >>"$log" 2>&1 || die "gentx failed: $log"
    [[ $i == 0 ]] || cp "$NET/node$i"/config/gentx/*.json "$NET/node0/config/gentx/"
  done
  ocpd genesis collect-gentxs --home "$NET/node0" >>"$log" 2>&1 || die "collect-gentxs failed: $log"

  # The live table, the live dealer penalties, and jail times cut from a day and an hour to a minute.
  python3 - "$genesis" "$INITIAL_HEIGHT" <<'PY'
import json, sys
path, initial_height = sys.argv[1], sys.argv[2]
with open(path) as f:
    g = json.load(f)
g["initial_height"] = initial_height
params = g["app_state"]["dealer"]["params"]
params["slash_bps_dkg"] = 5000
params["slash_bps_hand_dealer"] = 1000
params["jail_seconds_dkg"] = "60"
params["jail_seconds_hand_dealer"] = "60"
# The live chain's params hold no dkg_version, which reads as 0.
params["dkg_version"] = 0
g["app_state"]["poker"] = {
    "next_table_id": 2,
    "tables": [{
        "id": 1, "creator": "", "label": "Proof table",
        "params": {
            "max_players": 9, "small_blind": 5000, "big_blind": 10000,
            "min_buy_in": 500000, "max_buy_in": 5000000,
            "action_timeout_secs": 30, "dealer_timeout_secs": 120,
        },
        "seats": [], "next_hand_id": 1, "button_seat": -1,
    }],
}
with open(path, "w") as f:
    json.dump(g, f, indent=2)
PY
  ocpd genesis validate-genesis --home "$NET/node0" >>"$log" 2>&1 || die "the genesis is invalid: $log"

  local ids=() peers
  for i in 0 1 2; do ids[i]="$(ocpd comet show-node-id --home "$NET/node$i")@127.0.0.1:$(p2p_port $i)"; done
  for i in 0 1 2; do
    [[ $i == 0 ]] || cp "$genesis" "$NET/node$i/config/genesis.json"
    peers="$(for p in 0 1 2; do [[ $p == "$i" ]] || printf '%s,' "${ids[p]}"; done)"
    configure_node "$i" "${peers%,}"
  done
  if [[ "$quiet" == quiet ]]; then
    ocpd init quiet --chain-id "$CHAIN_ID" --home "$NET/node3" >>"$log" 2>&1
    cp "$genesis" "$NET/node3/config/genesis.json"
    configure_node 3 "${ids[0]},${ids[1]},${ids[2]}"
    set_toml "$NET/node3/config/config.toml" broadcast false
  fi

  # Each validator's operator address and key, for its dealer daemon.
  VALOPER=() VALADDR=() VALKEY=() PASSPHRASE=()
  for i in 0 1 2; do
    VALOPER[i]="$(ocpd keys show validator --bech val -a --home "$NET/node$i" --keyring-backend test)"
    VALADDR[i]="$(ocpd keys show validator -a --home "$NET/node$i" --keyring-backend test)"
    VALKEY[i]="$(echo y | ocpd keys export validator --unsafe --unarmored-hex --home "$NET/node$i" --keyring-backend test 2>/dev/null | tail -1)"
    PASSPHRASE[i]="$(openssl rand -hex 16)"
  done
  # Validators in ascending operator order, which is the order of reveals and of DKG indexes.
  ORDER=($(for i in 0 1 2; do echo "${VALOPER[i]} $i"; done | sort | awk '{print $2}'))
}

node_start() { # index
  local home="$NET/node$1"
  "$OCPD" start --home "$home" \
    --rpc.laddr "tcp://127.0.0.1:$(rpc_port "$1")" --p2p.laddr "tcp://127.0.0.1:$(p2p_port "$1")" \
    --grpc.address "127.0.0.1:$(grpc_port "$1")" --api.enable --api.address "tcp://127.0.0.1:$(api_port "$1")" \
    --rpc.pprof_laddr 127.0.0.1:0 >>"$NET/logs/node$1.log" 2>&1 3>&- &
  echo $! >"$PIDS/$NET_NAME.node$1"
}
node_stop() { proc_stop "node$1"; }

# Starts the nodes, waits for the first block, then follows the chain's events into $EVENTS.
net_start() {
  local i tries=0
  for i in 0 1 2; do node_start "$i"; done
  [[ -d "$NET/node3" ]] && node_start 3
  until [[ "$(chain_height 2>/dev/null || echo 0)" -ge "$INITIAL_HEIGHT" ]]; do
    sleep 1
    ((++tries < STALL_SECS)) || die "no first block after $STALL_SECS s: $NET/logs/node0.log"
  done
  : >"$EVENTS"
  events_follow "$INITIAL_HEIGHT"
  say "chain is up at height $(chain_height) (rpc $(rpc_url 0), ${NET_BLOCK_SECONDS:-$BLOCK_SECONDS} s blocks)"
}

events_follow() { # from: appends the chain's events from that height to $EVENTS
  node "$ROOT/scripts/dealer-events.mjs" --rpc "$(rpc_url 0)" --from "$1" --follow --time --heartbeat >>"$EVENTS" 2>>"$NET/logs/events.err" 3>&- &
  echo $! >"$PIDS/$NET_NAME.events"
}

# Restarts the three validators with SECONDS between blocks. Daemons and players keep running and
# reconnect; the event scan continues from the block after the last one it printed.
net_set_block_seconds() {
  local i
  proc_stop events
  for i in 0 1 2; do node_stop "$i"; set_toml "$NET/node$i/config/config.toml" timeout_commit "\"$1s\""; done
  for i in 0 1 2; do node_start "$i"; done
  wait_height $(($(ev_scanned) + 1))
  events_follow $(($(ev_scanned) + 1))
  say "validators restarted with $1 s blocks at height $(chain_height)"
}

# ---- processes -----------------------------------------------------------------------------

proc_stop() { # name [signal]
  local file="$PIDS/$NET_NAME.$1" pid
  [[ -f "$file" ]] || return 0
  pid="$(cat "$file")"
  kill "-${2:-TERM}" "$pid" 2>/dev/null || true
  # A stopped process must be gone before its successor reads the same state directory.
  local tries=0
  while kill -0 "$pid" 2>/dev/null && ((++tries < 100)); do sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$file"
}

proc_alive() { local file="$PIDS/$NET_NAME.$1"; [[ -f "$file" ]] && kill -0 "$(cat "$file")" 2>/dev/null; }

# Kills every process this run started, in every network.
stop_all() {
  local file pid
  [[ -d "$PIDS" ]] || return 0
  for file in "$PIDS"/*; do
    [[ -f "$file" ]] || continue
    kill "$(cat "$file")" 2>/dev/null || true
  done
  sleep 1
  for file in "$PIDS"/*; do
    [[ -f "$file" ]] || continue
    pid="$(cat "$file")"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$file"
  done
}

dealer_env() { # index: the environment of validator index's dealer daemon, as the live units set it
  cat <<EOF
NODE_ENV=production
DEALER_VALIDATOR_ADDRESS=${VALOPER[$1]}
DEALER_VALIDATOR_PRIVKEY_HEX=${VALKEY[$1]}
DEALER_COSMOS_RPC_URL=$(rpc_url "$1")
DEALER_COSMOS_LCD_URL=$(lcd_url "$1")
DEALER_BECH32_PREFIX=ocp
DEALER_GAS_PRICE=0$DENOM
DEALER_STATE_PASSPHRASE=${PASSPHRASE[$1]}
DEALER_STATE_DIR=$NET/state/dealer-$1
DEALER_POLL_INTERVAL_MS=${DEALER_POLL_INTERVAL_MS:-2000}
DEALER_COMMITTEE_SIZE=3
DEALER_THRESHOLD=2
DEALER_SHUFFLE_ROUNDS=$SHUFFLE_ROUNDS
EOF
}

# daemon_run TREE NAME INDEX [KEY=VALUE ...]: starts TREE's dealer daemon for validator INDEX,
# logging to logs/NAME.log (appended, so a restart continues the same file).
daemon_run() {
  local tree="$1" name="$2" index="$3"
  shift 3
  mkdir -p "$NET/state/dealer-$index"
  echo "--- started at height $(chain_height) $*" >>"$NET/logs/$name.log"
  # cwd is the network's directory: the daemon loads a .env from its cwd, and there is none here.
  (cd "$NET" && exec env -i PATH="$PATH" HOME="$NET" $(dealer_env "$index") "$@" node "$tree/apps/dealer-daemon/dist/index.js") >>"$NET/logs/$name.log" 2>&1 3>&- &
  echo $! >"$PIDS/$NET_NAME.$name"
}
daemon_start()     { local i="$1"; shift; daemon_run "$ROOT" "dealer-$i" "$i" "$@"; }
daemon_start_old() { local i="$1"; shift; daemon_run "$OLD_TREE" "old-dealer-$i" "$i" "$@"; }
daemon_stop()      { proc_stop "dealer-$1" "${2:-TERM}"; }
daemon_log()       { echo "$NET/logs/dealer-$1.log"; }

# What `--explain` prints for validator INDEX. It sends nothing.
daemon_explain() {
  (cd "$NET" && env -i PATH="$PATH" HOME="$NET" $(dealer_env "$1") node "$ROOT/apps/dealer-daemon/dist/index.js" --explain) 2>&1
}

# bot_run TREE NAME PLAYER: a calling station, so every hand reaches showdown, that acts as soon as it may.
bot_run() {
  local tree="$1" name="$2" player="$3"
  (cd "$NET" && exec env -i PATH="$PATH" HOME="$NET" \
    BOT_TABLE_ID=1 BOT_PRIVKEY_HEX="${PLAYER_KEY[$player]}" BOT_STRATEGY=calling-station BOT_NAME="$name" \
    BOT_COSMOS_RPC_URL="$(rpc_url 0)" BOT_COSMOS_LCD_URL="$(lcd_url 0)" BOT_GAS_PRICE="0$DENOM" \
    BOT_POLL_INTERVAL_MS="${BOT_POLL_INTERVAL_MS:-500}" BOT_AUTO_SIT=true BOT_AUTO_START_HAND=true BOT_AUTO_REBUY=true \
    node "$tree/apps/bot/dist/index.js") >>"$NET/logs/$name.log" 2>&1 3>&- &
  echo $! >"$PIDS/$NET_NAME.$name"
}
bot_start() { bot_run "$ROOT" "bot-$1" "$1"; }

# ---- the chain, read ------------------------------------------------------------------------

chain_status() { curl -s -m 5 "$(rpc_url 0)/status"; }
chain_height() { chain_status | jq -r '.result.sync_info.latest_block_height'; }
# The latest block's header time, in Unix seconds.
chain_time()   { chain_status | jq -r '.result.sync_info.latest_block_time | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'; }

# The 8-byte big-endian counter under key 0x01 of the dealer store: the only epoch id BeginEpoch takes.
next_epoch_id() {
  local hex
  hex="$(curl -s -m 5 "$(rpc_url 0)/abci_query?path=%22/store/dealer/key%22&data=0x01" | jq -r '.result.response.value' | base64 -d | od -An -tx1 | tr -d ' \n')"
  echo $((16#$hex))
}

# The sequence of validator INDEX's account: it moves with every transaction that account lands.
account_sequence() { ocpq auth account "${VALADDR[$1]}" | jq -r '.account.value.sequence // .account.sequence // "0"'; }

validators_json() { ocpq staking validators; }
bonded_count() { validators_json | jq '[.validators[] | select(.status == "BOND_STATUS_BONDED" or .status == 3)] | length'; }
jailed_count() { validators_json | jq '[.validators[] | select(.jailed == true)] | length'; }
is_jailed()    { validators_json | jq -r --arg v "${VALOPER[$1]}" '.validators[] | select(.operator_address == $v) | .jailed // false'; }

# Sleeps until the chain is at HEIGHT. Dies when the chain stops making blocks.
wait_height() {
  local target="$1" last=0 now since
  since="$(date +%s)"
  while :; do
    now="$(chain_height 2>/dev/null || echo 0)"
    [[ "$now" =~ ^[0-9]+$ ]] || now=0
    ((now >= target)) && return 0
    if ((now > last)); then last="$now"; since="$(date +%s)"; fi
    (($(date +%s) - since < STALL_SECS)) || die "the chain made no block for $STALL_SECS s (height $last, waiting for $target)"
    sleep 0.5
  done
}
wait_blocks() { wait_height $(($(chain_height) + $1)); }

# Sleeps until the chain's own clock has moved SECONDS past now. Jail times and hand deadlines are block time.
wait_chain_seconds() {
  local target=$(($(chain_time) + $1))
  while (($(chain_time) < target)); do wait_blocks 1; done
}

# ---- events ---------------------------------------------------------------------------------
# $EVENTS holds "<height> <time> <Type> key=value ..." and "<height> <time> -" for a block with none.

ev_scanned() { tail -n 1 "$EVENTS" 2>/dev/null | awk 'END { print $1 + 0 }'; }

# ev_list TYPE FROM TO [text ...]: events of TYPE at heights FROM..TO whose line holds every text.
ev_list() {
  local type="$1" from="$2" to="$3" text out
  shift 3
  out="$(awk -v t="$type" -v a="$from" -v b="$to" '$3 == t && $1 >= a && $1 <= b' "$EVENTS")"
  for text in "$@"; do out="$(grep -F -- "$text" <<<"$out" || true)"; done
  [[ -z "$out" ]] || echo "$out"
}
ev_count() { ev_list "$@" | grep -c . || true; }
ev_attr() { sed -nE "s/.* $2=(\"[^\"]*\"|[^ ]*).*/\1/p" <<<"$1" | tr -d '"'; } # line key

# ev_wait TYPE FROM BLOCKS [text ...]: prints the first such event at or after FROM, waiting until
# the scan is BLOCKS past FROM. Returns 1 when there is none.
ev_wait() {
  local type="$1" from="$2" blocks="$3" line
  shift 3
  while :; do
    line="$(ev_list "$type" "$from" 999999999 "$@" | sed -n 1p)"
    if [[ -n "$line" ]]; then echo "$line"; return 0; fi
    (($(ev_scanned) <= from + blocks)) || return 1
    ev_sync $(($(ev_scanned) + 1))
  done
}

# Waits until the event scan has read HEIGHT, so counts up to it are final.
ev_sync() {
  wait_height "$1"
  while (($(ev_scanned) < $1)); do
    proc_alive events || die "the event scan stopped: $NET/logs/events.err"
    sleep 0.2
  done
}

# log_wait FILE BLOCKS PATTERN: waits up to BLOCKS blocks for a line matching the grep -E PATTERN.
log_wait() {
  local file="$1" limit=$(($(chain_height) + $2)) pattern="$3"
  while ! grep -Eq -- "$pattern" "$file" 2>/dev/null; do
    (($(chain_height) < limit)) || return 1
    sleep 0.5
  done
}
log_has() { grep -Eq -- "$2" "$1" 2>/dev/null; }
# The lines a daemon wrote since it was last started, in FILE.since.
since_start() {
  awk '/^--- started at height/ { out = ""; next } { out = out $0 "\n" } END { printf "%s", out }' "$1" >"$1.since"
  echo "$1.since"
}

# ---- transactions typed by a person -----------------------------------------------------------

# cli_tx NODE KEY module command [flags ...]: signs with KEY from node NODE's keyring, waits for the
# block that holds it, and prints "<height> code=0". Its hash is left in $NET/last-tx. Dies when no
# block takes it or it fails in its block.
cli_tx() {
  local index="$1" key="$2" before out hash
  shift 2
  before="$(chain_height)"
  out="$("$OCPD" tx "$@" --from "$key" --home "$NET/node$index" --keyring-backend test --chain-id "$CHAIN_ID" \
    --node "tcp://127.0.0.1:$(rpc_port 0)" --gas 5000000 --yes --output json 2>&1)" || die "ocpd tx $* failed: $out"
  hash="$(jq -r '.txhash // empty' <<<"$out" 2>/dev/null)"
  [[ -n "$hash" && "$(jq -r '.code' <<<"$out")" == 0 ]] || die "ocpd tx $* was refused: $out"
  echo "$hash" >"$NET/last-tx"
  out="$(node "$ROOT/scripts/dealer-events.mjs" --rpc "$(rpc_url 0)" --from "$before" --find-tx "$hash" --wait 30)" || die "ocpd tx $* ($hash) is in no block"
  [[ "$out" == *" code=0" ]] || die "ocpd tx $* failed in its block: $out"
  echo "$out"
}

# ---- checks ---------------------------------------------------------------------------------

# check ID WHAT EXPECTED OBSERVED VERDICT: one line in the scenario's log and on the terminal, one
# row for the final table. liveness-repro.sh keeps the terminal on descriptor 3.
check() {
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >>"$CHECKS"
  say "CHECK $1 $2: $4 (want $3) $5"
  if { true >&3; } 2>/dev/null; then say "CHECK $1 $2: $4 (want $3) $5" >&3; fi
}
# check_is ID WHAT EXPECTED OBSERVED: passes when the two are the same text.
check_is() { if [[ "$3" == "$4" ]]; then check "$1" "$2" "$3" "$4" PASS; else check "$1" "$2" "$3" "$4" FAIL; fi; }
