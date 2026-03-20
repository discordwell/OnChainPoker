import type { GameState } from "../hooks/useGameState";
import type { PlayerActionForm, LobbyFilter } from "../lib/types";
import { PokerTable } from "./PokerTable";
import { ChainVerificationBadge } from "./ChainVerificationBadge";
import { statusTone, prettyJson, formatTimestamp, formatRelative, wsTone, errorMessage } from "../lib/utils";
import { toWsUrl } from "../lib/coordinatorUrl";
import { DEFAULT_COSMOS_RPC_URL, DEFAULT_COSMOS_LCD_URL } from "../lib/constants";

export function AdminView({ g }: { g: GameState }) {

  const renderPokerTable = () => {
    const tableProps = g.renderPokerTableProps;
    return tableProps ? <PokerTable {...tableProps} handHistory={g.handHistory.get(g.selectedTableId) ?? []} /> : null;
  };

  const renderChat = () => (
    g.selectedTableId ? (
      <div className="chat-panel">
        <h4 className="chat-panel__title">Table Chat</h4>
        <div className="chat-messages">
          {g.chatMessages.length === 0 && (
            <p className="chat-empty">No messages yet</p>
          )}
          {g.chatMessages.map((m, i) => (
            <div key={i} className="chat-msg">
              <span className="chat-msg__sender">{m.sender.slice(0, 8)}...</span>
              <span className="chat-msg__text">{m.text}</span>
            </div>
          ))}
          <div ref={g.chatEndRef} />
        </div>
        <div className="chat-input-row">
          <input
            className="chat-input"
            value={g.chatInput}
            onChange={(e) => g.setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); g.sendChat(); } }}
            placeholder="Type a message..."
            maxLength={200}
          />
          <button type="button" onClick={g.sendChat} disabled={!g.chatInput.trim()}>Send</button>
        </div>
      </div>
    ) : null
  );

  const renderCreateTableForm = () => (
    <form className="create-table-form" onSubmit={(e) => {
      void g.submitCreateTable(e);
    }}>
      <label>
        Label
        <input
          value={g.createTableForm.label}
          onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, label: e.target.value }))}
          placeholder="My Table"
        />
      </label>
      <div className="create-table-grid">
        <label>
          Small Blind
          <input required value={g.createTableForm.smallBlind} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, smallBlind: e.target.value }))} inputMode="numeric" />
        </label>
        <label>
          Big Blind
          <input required value={g.createTableForm.bigBlind} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, bigBlind: e.target.value }))} inputMode="numeric" />
        </label>
        <label>
          Min Buy-In
          <input required value={g.createTableForm.minBuyIn} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, minBuyIn: e.target.value }))} inputMode="numeric" />
        </label>
        <label>
          Max Buy-In
          <input required value={g.createTableForm.maxBuyIn} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, maxBuyIn: e.target.value }))} inputMode="numeric" />
        </label>
      </div>
      <label>
        Password (optional)
        <input type="password" value={g.createTableForm.password} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, password: e.target.value }))} placeholder="Leave blank for open table" />
      </label>
      <details open={g.showCreateAdvanced} onToggle={(e) => g.setShowCreateAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary style={{ cursor: "pointer" }}>Advanced</summary>
        <div className="create-table-advanced">
          <label>Max Players<input value={g.createTableForm.maxPlayers} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, maxPlayers: e.target.value }))} inputMode="numeric" /></label>
          <label>Action Timeout (s)<input value={g.createTableForm.actionTimeoutSecs} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, actionTimeoutSecs: e.target.value }))} inputMode="numeric" /></label>
          <label>Dealer Timeout (s)<input value={g.createTableForm.dealerTimeoutSecs} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, dealerTimeoutSecs: e.target.value }))} inputMode="numeric" /></label>
          <label>Player Bond<input value={g.createTableForm.playerBond} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, playerBond: e.target.value }))} inputMode="numeric" /></label>
          <label>Rake BPS<input value={g.createTableForm.rakeBps} onChange={(e) => g.setCreateTableForm((prev) => ({ ...prev, rakeBps: e.target.value }))} inputMode="numeric" /></label>
        </div>
      </details>
      <button type="submit" disabled={g.createTableSubmit.kind === "pending" || g.playerWallet.status !== "connected"}>
        {g.createTableSubmit.kind === "pending" ? "Creating..." : "Create Table"}
      </button>
      {g.createTableSubmit.message && (
        <p className={g.createTableSubmit.kind === "success" ? "create-table-success" : g.createTableSubmit.kind === "error" ? "error-banner" : "hint"}>
          {g.createTableSubmit.message}
        </p>
      )}
    </form>
  );

  return (
    <div className="app-shell">
      <header className="topbar panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <p className="kicker">OnChainPoker</p>
            <h1>Control Room</h1>
          </div>
          <button type="button" className="topbar-btn topbar-btn--accent" onClick={() => g.setViewMode("game")}>
            Game View
          </button>
        </div>

        <div className="endpoint-row">
          <label htmlFor="coordinator-url">Coordinator URL</label>
          <div className="endpoint-controls">
            <input
              id="coordinator-url"
              value={g.coordinatorInput}
              onChange={(event) => g.setCoordinatorInput(event.target.value)}
              onKeyDown={g.onInputKeyDown}
              placeholder="http://127.0.0.1:8788"
              spellCheck={false}
            />
            <button type="button" onClick={g.applyCoordinatorBase}>
              Connect
            </button>
          </div>
          <p className="hint">WebSocket endpoint: {toWsUrl(g.coordinatorBase)}</p>
        </div>

        <div className="status-grid">
          <div className="status-tile">
            <span className={`dot ${g.health.error ? "status-closed" : "status-open"}`} />
            <div>
              <p>Health</p>
              <strong>
                {g.health.loading
                  ? "Checking..."
                  : g.health.error
                    ? "Unavailable"
                    : `${g.health.data?.name ?? "coordinator"} (${g.health.data?.chainAdapter ?? "?"})`}
              </strong>
            </div>
          </div>

          <div className="status-tile">
            <span className={`dot ${wsTone(g.wsStatus)}`} />
            <div>
              <p>Event Stream</p>
              <strong>{g.wsStatus}</strong>
            </div>
          </div>

          <div className="status-tile">
            <span
              className={`dot ${
                g.playerWallet.status === "connected"
                  ? "status-open"
                  : g.playerWallet.status === "connecting"
                    ? "status-live"
                    : g.playerWallet.status === "error"
                      ? "status-closed"
                      : "status-muted"
              }`}
            />
            <div>
              <p>Wallet</p>
              <strong>
                {g.playerWallet.status === "connected"
                  ? g.playerWallet.address
                  : g.playerWallet.status === "error"
                    ? "Error"
                    : g.playerWallet.status === "connecting"
                      ? "Connecting"
                      : "Disconnected"}
              </strong>
            </div>
          </div>

          <div className="status-tile">
            <span className="dot status-live" />
            <div>
              <p>Tables</p>
              <strong>{g.tableList.length}</strong>
            </div>
          </div>
        </div>

        {(g.health.error || g.wsError) && (
          <p className="error-banner">{g.health.error ?? g.wsError}</p>
        )}
      </header>

      <main className="dashboard">
        <section className="panel">
          <div className="section-header">
            <h2>Player Desk</h2>
            <button
              type="button"
              onClick={() => {
                if (g.selectedTableId && g.playerWallet.status === "connected") {
                  void g.loadPlayerTable(g.selectedTableId, false);
                }
              }}
            >
              Refresh
            </button>
          </div>

          {g.seatedTableIds.length > 0 && (
            <div className="table-tabs">
              {g.seatedTableIds.map((tid) => {
                const info = g.tableList.find((t) => t.tableId === tid);
                return (
                  <button
                    key={tid}
                    type="button"
                    className={`table-tab${tid === g.selectedTableId ? " active" : ""}`}
                    onClick={() => g.setSelectedTableId(tid)}
                  >
                    <span>#{tid}</span>
                    {info && <span>{info.params.smallBlind}/{info.params.bigBlind}</span>}
                    {info && <span className={`badge ${statusTone(info.status)}`}>{info.status}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {!g.selectedTable && <p className="placeholder">Select a table to join as a player.</p>}

          {g.selectedTableId && <ChainVerificationBadge {...g.chainVerification} cometMetrics={g.cometMetrics} />}

          {renderPokerTable()}

          {renderChat()}

          <div className="stack-two">
            <div>
              <h4>Wallet Session</h4>
              <p className="hint">
                Chain: {g.playerWallet.chainId} <br />
                RPC: {DEFAULT_COSMOS_RPC_URL} <br />
                LCD: {DEFAULT_COSMOS_LCD_URL}
              </p>

              {g.playerWallet.status === "connected" ? (
                <>
                  <p>Connected as {g.playerWallet.address}</p>
                  <p className="hint">Seat state: {g.playerSeat ? `#${g.playerSeat.seat}` : "Not seated"}</p>
                  <div style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={g.requestFaucet}
                      disabled={g.faucetStatus.kind === "pending"}
                      style={{ marginRight: "0.5rem" }}
                    >
                      {g.faucetStatus.kind === "pending" ? "Requesting..." : "Get Free CHIPS"}
                    </button>
                    {g.faucetStatus.message && (
                      <p className={g.faucetStatus.kind === "error" ? "error-banner" : "hint"}>
                        {g.faucetStatus.message}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="placeholder">
                    {g.playerWallet.status === "connecting" ? "Connecting wallet..." : "Wallet not connected"}
                  </p>
                  <p className="hint">Connect a compatible Cosmos wallet with onchainpoker prefix account (ocp).</p>
                  <button type="button" onClick={g.connectWallet} disabled={g.playerWallet.status === "connecting"}>
                    Connect wallet
                  </button>
                </>
              )}

              {g.playerWallet.error && <p className="error-banner">{g.playerWallet.error}</p>}

              {g.playerWallet.status === "connected" && g.playerKeyState === "locked" && (
                <div style={{ marginTop: "0.5rem" }}>
                  <p className="hint">Keys are encrypted. Enter passphrase to unlock.</p>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <input
                      type="password"
                      value={g.keyPassphrase}
                      onChange={(e) => g.setKeyPassphrase(e.target.value)}
                      placeholder="Passphrase"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          g.doUnlock();
                        }
                      }}
                    />
                    <button type="button" onClick={g.doUnlock}>Unlock</button>
                  </div>
                  {g.keyError && <p className="error-banner">{g.keyError}</p>}
                </div>
              )}

              {g.playerWallet.status === "connected" && g.playerKeyState === "unlocked" && (
                <div style={{ marginTop: "0.5rem" }}>
                  <details>
                    <summary style={{ cursor: "pointer" }}>Protect Keys</summary>
                    <p className="hint">Encrypt your player keys with a passphrase. You will need it on each page load.</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      <input
                        type="password"
                        value={g.protectPassphrase}
                        onChange={(e) => g.setProtectPassphrase(e.target.value)}
                        placeholder="New passphrase"
                      />
                      <input
                        type="password"
                        value={g.protectConfirm}
                        onChange={(e) => g.setProtectConfirm(e.target.value)}
                        placeholder="Confirm passphrase"
                      />
                      <button type="button" disabled={!g.protectPassphrase || g.protectPassphrase !== g.protectConfirm} onClick={() => {
                        void g.handleProtectKeys();
                      }}>Encrypt Keys</button>
                    </div>
                    {g.protectStatus && <p className="hint">{g.protectStatus}</p>}
                  </details>
                </div>
              )}
            </div>

            <div>
              <h4>Seat</h4>
              <form className="seat-form" onSubmit={g.submitPlayerSeat}>
                <label>
                  Buy-In
                  <input
                    required
                    value={g.playerSeatForm.buyIn}
                    onChange={(event) => g.onPlayerSeatInputChange("buyIn", event.target.value)}
                    placeholder="1000000"
                    disabled={g.playerSitSubmit.kind === "pending"}
                  />
                </label>

                {g.selectedTable?.params?.passwordHash && (
                  <label>
                    Password
                    <input
                      type="password"
                      value={g.playerSeatForm.password}
                      onChange={(event) => g.onPlayerSeatInputChange("password", event.target.value)}
                      placeholder="Table password"
                      disabled={g.playerSitSubmit.kind === "pending"}
                    />
                  </label>
                )}

                <button
                  type="submit"
                  disabled={
                    g.playerSitSubmit.kind === "pending" ||
                    g.playerWallet.status !== "connected" ||
                    !g.selectedTableId
                  }
                >
                  {g.playerSitSubmit.kind === "pending" ? "Submitting..." : "Sit"}
                </button>
              </form>

              <p className={g.playerSitSubmit.kind === "error" ? "error-banner" : "hint"}>
                {g.playerSitSubmit.message}
              </p>

              {g.playerSeat && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn-leave"
                      disabled={
                        g.playerLeaveSubmit.kind === "pending" ||
                        g.playerWallet.status !== "connected" ||
                        !g.selectedTableId ||
                        Boolean(g.playerTableForSelected?.hand && g.playerSeat.inHand)
                      }
                      onClick={g.submitPlayerLeave}
                    >
                      {g.playerLeaveSubmit.kind === "pending" ? "Leaving..." : "Leave Table"}
                    </button>
                  </div>
                  {g.playerLeaveSubmit.message && (
                    <p className={g.playerLeaveSubmit.kind === "error" ? "error-banner" : "hint"}>
                      {g.playerLeaveSubmit.message}
                    </p>
                  )}

                  <div className="rebuy-row">
                    <input
                      value={g.rebuyAmount}
                      onChange={(e) => g.setRebuyAmount(e.target.value)}
                      placeholder="Rebuy amount"
                      inputMode="numeric"
                      disabled={g.rebuySubmit.kind === "pending"}
                    />
                    <button
                      type="button"
                      disabled={
                        g.rebuySubmit.kind === "pending" ||
                        g.playerWallet.status !== "connected" ||
                        !g.selectedTableId ||
                        Boolean(g.playerTableForSelected?.hand && g.playerSeat.inHand)
                      }
                      onClick={g.submitRebuy}
                    >
                      {g.rebuySubmit.kind === "pending" ? "Rebuying..." : "Rebuy"}
                    </button>
                    {Boolean(g.playerTableForSelected?.hand && g.playerSeat.inHand) && (
                      <span className="rebuy-hint">Available between hands</span>
                    )}
                  </div>
                  {g.rebuySubmit.message && (
                    <p className={g.rebuySubmit.kind === "error" ? "error-banner" : "hint"}>
                      {g.rebuySubmit.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="stack-two">
            <div>
              <h4>Current Hand</h4>
              {g.playerTable.loading && <p className="placeholder">Loading player table state...</p>}
              {g.playerTable.error && <p className="error-banner">{g.playerTable.error}</p>}

              {!g.playerTable.loading && !g.playerTable.error && g.playerTableForSelected ? (
                <>
                  <dl className="facts">
                    <div>
                      <dt>Hand</dt>
                      <dd>{g.playerTableForSelected.hand?.handId ?? "none"}</dd>
                    </div>
                    <div>
                      <dt>Phase</dt>
                      <dd>{g.playerTableForSelected.hand?.phase || "waiting"}</dd>
                    </div>
                    <div>
                      <dt>Your seat</dt>
                      <dd>{g.playerSeat ? `#${g.playerSeat.seat}` : "not seated"}</dd>
                    </div>
                    <div>
                      <dt>Turn</dt>
                      <dd>{g.playerActionEnabled ? "you" : "other"}</dd>
                    </div>
                  </dl>

                  <form className="seat-form" onSubmit={g.submitPlayerAction}>
                    <label>
                      Action
                      <select
                        value={g.playerActionForm.action}
                        onChange={(event) =>
                          g.onPlayerActionInputChange("action", event.target.value as PlayerActionForm["action"])
                        }
                        disabled={g.playerActionSubmit.kind === "pending"}
                      >
                        <option value="fold">fold</option>
                        <option value="check">check</option>
                        <option value="call">call</option>
                        <option value="bet">bet</option>
                        <option value="raise">raise</option>
                      </select>
                    </label>

                    {(g.playerActionForm.action === "bet" || g.playerActionForm.action === "raise") && (
                      <label>
                        Amount
                        <input
                          required
                          value={g.playerActionForm.amount}
                          onChange={(event) =>
                            g.onPlayerActionInputChange("amount", event.target.value)
                          }
                          inputMode="numeric"
                          disabled={g.playerActionSubmit.kind === "pending"}
                        />
                      </label>
                    )}

                    <button
                      type="submit"
                      disabled={
                        g.playerActionSubmit.kind === "pending" ||
                        g.playerWallet.status !== "connected" ||
                        !g.selectedTableId ||
                        !g.playerActionEnabled ||
                        !g.playerTableForSelected?.hand
                      }
                    >
                      {g.playerActionSubmit.kind === "pending" ? "Submitting..." : "Take Action"}
                    </button>
                  </form>
                </>
              ) : (
                <p className="placeholder">Connect wallet and connect to a table to see hand state.</p>
              )}

              {g.playerActionSubmit.message && (
                <p className={g.playerActionSubmit.kind === "error" ? "error-banner" : "hint"}>
                  {g.playerActionSubmit.message}
                </p>
              )}
            </div>

            <div>
              <h4>Seat Snapshot</h4>
              {g.playerTable.loading && <p className="placeholder">Loading seat snapshot...</p>}
              {!g.playerTableForSelected && !g.playerTable.loading ? (
                <p className="placeholder">No seat snapshot yet. Join a seated player to populate.</p>
              ) : (
                <div>
                  {(g.playerTableForSelected?.seats ?? []).map((seat) => (
                    <article key={`${seat.seat}`} className="intent-card">
                      <header>
                        <strong>Seat {seat.seat}</strong>
                        <span>{seat.player || "-"}</span>
                      </header>
                      <p>
                        stack {seat.stack} | bond {seat.bond}
                      </p>
                      <small>
                        inHand: {seat.inHand ? "yes" : "no"} | folded:{" "}
                        {seat.folded ? "yes" : "no"} | all-in: {seat.allIn ? "yes" : "no"}
                      </small>
                      {seat.player && (
                        <textarea
                          className="player-note"
                          placeholder="Private note..."
                          value={g.playerNotes[seat.player] ?? ""}
                          onChange={(e) => g.setPlayerNotes((prev) => ({ ...prev, [seat.player]: e.target.value }))}
                          rows={1}
                        />
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
        <div className="section-header">
            <h2>Lobby</h2>
            <button type="button" onClick={() => void g.loadTables(true)}>
              Refresh
            </button>
          </div>

          {g.tables.loading && !g.tables.data && <p className="placeholder">Loading tables...</p>}
          {g.tables.error && <p className="error-banner">{g.tables.error}</p>}

          <div className="lobby-filters">
            <input
              value={g.lobbyFilter.search}
              onChange={(e) => g.setLobbyFilter((prev) => ({ ...prev, search: e.target.value }))}
              placeholder="Search by ID or label"
            />
            <select
              value={g.lobbyFilter.status}
              onChange={(e) => g.setLobbyFilter((prev) => ({ ...prev, status: e.target.value as LobbyFilter["status"] }))}
            >
              <option value="all">All status</option>
              <option value="open">Open</option>
              <option value="in_hand">In hand</option>
            </select>
            <select
              value={g.lobbyFilter.password}
              onChange={(e) => g.setLobbyFilter((prev) => ({ ...prev, password: e.target.value as LobbyFilter["password"] }))}
            >
              <option value="all">Any access</option>
              <option value="open">No password</option>
              <option value="protected">Password</option>
            </select>
            <select
              value={g.lobbyFilter.sort}
              onChange={(e) => g.setLobbyFilter((prev) => ({ ...prev, sort: e.target.value as LobbyFilter["sort"] }))}
            >
              <option value="id-asc">ID asc</option>
              <option value="id-desc">ID desc</option>
              <option value="blinds-asc">Blinds asc</option>
              <option value="blinds-desc">Blinds desc</option>
            </select>
          </div>

          {!g.tables.loading && g.tableList.length === 0 && (
            <p className="placeholder">No tables reported by coordinator.</p>
          )}

          {!g.tables.loading && g.tableList.length > 0 && g.filteredTableList.length === 0 && (
            <p className="placeholder">No tables match filters ({g.tableList.length} total).</p>
          )}

          <ul className="table-list">
            {g.filteredTableList.map((table) => (
              <li key={table.tableId}>
                <button
                  type="button"
                  className={`table-row ${table.tableId === g.selectedTableId ? "active" : ""}`}
                  onClick={() => g.setSelectedTableId(table.tableId)}
                >
                  <div>
                    <strong>#{table.tableId}{table.label ? ` ${table.label}` : ""}</strong>
                    <p>
                      blinds {table.params.smallBlind}/{table.params.bigBlind}
                      {table.params.passwordHash ? " \u{1F512}" : ""}
                    </p>
                  </div>
                  <div className="table-meta">
                    {table.params.passwordHash && <span className="badge status-muted">Password</span>}
                    <span className={`badge ${statusTone(table.status)}`}>{table.status}</span>
                    <small>{formatTimestamp(table.updatedAtMs)}</small>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {g.playerWallet.status === "connected" && (
            <div style={{ marginTop: "1rem" }}>
              <h4>Create Table</h4>
              {renderCreateTableForm()}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Table Detail</h2>
            {g.selectedTableId && (
              <button
                type="button"
                onClick={() => {
                  void g.loadSeatIntents(g.selectedTableId, true);
                  void g.loadDealerViews(g.selectedTableId);
                  if (g.playerWallet.status === "connected") {
                    void g.loadPlayerTable(g.selectedTableId);
                  }
                }}
              >
                Refresh
              </button>
            )}
          </div>

          {!g.selectedTable && <p className="placeholder">Select a table to inspect state and seat intents.</p>}

          {g.selectedTable && (
            <>
              <div className="table-summary">
                <div>
                  <p className="kicker">Table</p>
                  <h3>{g.selectedTable.tableId}</h3>
                </div>
                <span className={`badge ${statusTone(g.selectedTable.status)}`}>{g.selectedTable.status}</span>
              </div>

              <dl className="facts">
                <div>
                  <dt>Max Players</dt>
                  <dd>{g.selectedTable.params.maxPlayers}</dd>
                </div>
                <div>
                  <dt>Blinds</dt>
                  <dd>
                    {g.selectedTable.params.smallBlind}/{g.selectedTable.params.bigBlind}
                  </dd>
                </div>
                <div>
                  <dt>Buy-in</dt>
                  <dd>
                    {g.selectedTable.params.minBuyIn} - {g.selectedTable.params.maxBuyIn}
                  </dd>
                </div>
              </dl>

              <h4 style={{ marginTop: "0.5rem" }}>Seat Intents</h4>
              {g.seatIntents.loading && <p className="placeholder">Loading intents...</p>}
              {g.seatIntents.error && <p className="error-banner">{g.seatIntents.error}</p>}
              {!g.seatIntents.loading && !g.seatIntents.error && (g.seatIntents.data?.length ?? 0) === 0 && (
                <p className="placeholder">No active intents.</p>
              )}

              {(g.seatIntents.data ?? []).map((intent) => (
                <article key={intent.intentId} className="intent-card">
                  <header>
                    <strong>Seat {intent.seat}</strong>
                    <span>{intent.player}</span>
                  </header>
                  <p>
                    buyIn {intent.buyIn ?? "-"} | bond {intent.bond ?? "-"}
                  </p>
                  <small>expires {formatRelative(intent.expiresAtMs)}</small>
                </article>
              ))}

              <details className="admin-collapse">
                <summary>Submit Seat Intent</summary>
                <form className="seat-form" onSubmit={g.submitSeatIntent}>
                  <label>
                    Player
                    <input
                      required
                      value={g.seatForm.player}
                      onChange={(event) => g.onSeatInputChange("player", event.target.value)}
                      placeholder="ocp1abc..."
                    />
                  </label>

                  <label>
                    Seat (0-8)
                    <input
                      required
                      value={g.seatForm.seat}
                      onChange={(event) => g.onSeatInputChange("seat", event.target.value)}
                      inputMode="numeric"
                    />
                  </label>

                  <label>
                    Buy-In (optional)
                    <input
                      value={g.seatForm.buyIn}
                      onChange={(event) => g.onSeatInputChange("buyIn", event.target.value)}
                      placeholder="1000000"
                    />
                  </label>

                  <label>
                    Bond (optional)
                    <input
                      value={g.seatForm.bond}
                      onChange={(event) => g.onSeatInputChange("bond", event.target.value)}
                      placeholder="10000"
                    />
                  </label>

                  <label>
                    pkPlayer (optional)
                    <input
                      value={g.seatForm.pkPlayer}
                      onChange={(event) => g.onSeatInputChange("pkPlayer", event.target.value)}
                      placeholder="base64"
                      spellCheck={false}
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={
                      g.seatSubmit.kind === "pending" ||
                      !g.selectedTableId ||
                      g.seatForm.player.trim().length === 0
                    }
                  >
                    {g.seatSubmit.kind === "pending" ? "Submitting..." : "Submit"}
                  </button>
                </form>

                {g.seatSubmit.message && (
                  <p className={g.seatSubmit.kind === "error" ? "error-banner" : "hint"}>
                    {g.seatSubmit.message}
                  </p>
                )}
              </details>

              <details className="admin-collapse">
                <summary>Raw Table State</summary>
                {g.rawTable.loading && <p className="placeholder">Loading...</p>}
                {g.rawTable.error && <p className="placeholder">{g.rawTable.error}</p>}
                {g.rawTable.data != null ? <pre>{prettyJson(g.rawTable.data)}</pre> : null}
              </details>

              <details className="admin-collapse">
                <summary>Dealer Next Action</summary>
                {g.dealerNext.loading && <p className="placeholder">Loading...</p>}
                {g.dealerNext.error && <p className="placeholder">{g.dealerNext.error}</p>}
                {g.dealerNext.data != null ? <pre>{prettyJson(g.dealerNext.data)}</pre> : null}
              </details>
            </>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Live Event Feed</h2>
            <button type="button" onClick={() => g.setEvents([])}>
              Clear
            </button>
          </div>

          {g.events.length === 0 && (
            <p className="placeholder">No events yet. Keep this tab open while coordinator streams chain events.</p>
          )}

          <div className="event-list">
            {g.events.map((event) => (
              <article key={`${event.eventIndex}-${event.timeMs}-${event.name}`} className="event-card">
                <header>
                  <strong>{event.name}</strong>
                  <span>#{event.eventIndex}</span>
                </header>
                <p>
                  table {event.tableId ?? "-"} | hand {event.handId ?? "-"}
                </p>
                <small>{formatTimestamp(event.timeMs)}</small>
                {event.data != null ? (
                  <details className="admin-collapse admin-collapse--inline">
                    <summary>data</summary>
                    <pre>{prettyJson(event.data)}</pre>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
