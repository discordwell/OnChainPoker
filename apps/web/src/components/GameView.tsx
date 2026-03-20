import type { GameState } from "../hooks/useGameState";
import { PokerTable } from "./PokerTable";
import { ChainVerificationBadge } from "./ChainVerificationBadge";
import { statusTone, wsTone } from "../lib/utils";

export function GameView({ g }: { g: GameState }) {
  const renderPokerTable = () => {
    const tableProps = g.renderPokerTableProps;
    if (!tableProps) return null;
    return <PokerTable {...tableProps} handHistory={g.handHistory.get(g.selectedTableId) ?? []} />;
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
    <div className="game-shell">
      {/* ─── Top Bar ─── */}
      <header className="game-topbar">
        <div className="game-topbar__left">
          <span className="game-topbar__logo">OCP</span>
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
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="game-topbar__center">
          {g.selectedTable ? (
            <>
              <strong>Table #{g.selectedTable.tableId}</strong>
              <span>{g.selectedTable.params.smallBlind}/{g.selectedTable.params.bigBlind}</span>
              <span className={`badge ${statusTone(g.selectedTable.status)}`}>{g.selectedTable.status}</span>
              <button
                type="button"
                className="topbar-btn topbar-btn--icon"
                title="Copy table link"
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}?table=${g.selectedTable!.tableId}`;
                  void navigator.clipboard.writeText(url);
                }}
              >
                {"\uD83D\uDD17"}
              </button>
            </>
          ) : (
            <span>No table selected</span>
          )}
        </div>

        <div className="game-topbar__right">
          {g.playerWallet.status === "connected" && g.formattedBalance != null && (
            <div className="game-topbar__balance">
              <span className="chip-icon" />
              <span>{g.formattedBalance}</span>
            </div>
          )}

          {g.selectedTableId && <ChainVerificationBadge {...g.chainVerification} cometMetrics={g.cometMetrics} />}

          {g.playerWallet.status === "connected" && (
            <button
              type="button"
              className="topbar-btn"
              onClick={g.requestFaucet}
              disabled={g.faucetStatus.kind === "pending"}
            >
              {g.faucetStatus.kind === "pending" ? "..." : "Faucet"}
            </button>
          )}

          {g.playerWallet.status === "connected" ? (
            <button type="button" className="topbar-btn" title={g.playerWallet.address}>
              {g.playerWallet.address.slice(0, 8)}...{g.playerWallet.address.slice(-4)}
            </button>
          ) : (
            <button type="button" className="topbar-btn topbar-btn--accent" onClick={g.connectWallet} disabled={g.playerWallet.status === "connecting"}>
              Connect
            </button>
          )}

          <span className="topbar-divider" />

          <button
            type="button"
            className="topbar-btn topbar-btn--icon"
            onClick={() => g.setSidebarOpen((p) => !p)}
            title="Settings"
          >
            {g.sidebarOpen ? "\u2715" : "\u2699"}
          </button>

          <button
            type="button"
            className="topbar-btn topbar-btn--icon"
            onClick={() => g.setViewMode("admin")}
            title="Admin view"
          >
            {"\u2630"}
          </button>
        </div>
      </header>

      {/* Faucet status toast */}
      {g.faucetStatus.message && (
        <div style={{ position: "fixed", top: 56, right: 16, zIndex: 200, maxWidth: 320 }}>
          <p className={g.faucetStatus.kind === "error" ? "error-banner" : "hint"} style={{ background: "var(--panel-solid)", padding: "0.5rem 0.75rem", borderRadius: 10, border: "1px solid var(--line)" }}>
            {g.faucetStatus.message}
          </p>
        </div>
      )}

      {/* ─── Game Stage ─── */}
      <main className="game-stage">
        {g.playerTable.loading && g.playerWallet.status === "connected" && !g.playerTableForSelected && (
          <p className="placeholder" style={{ position: "absolute", top: "1rem" }}>Loading table...</p>
        )}
        {g.playerTable.error && g.playerWallet.status === "connected" && (
          <p className="error-banner" style={{ position: "absolute", top: "1rem", maxWidth: 400 }}>{g.playerTable.error}</p>
        )}
        {renderPokerTable()}

        {/* Lobby overlay — browse tables without wallet */}
        {g.showLobby && (
          <div className="onboard-overlay">
            <div className="onboard-card">
              <h2>OnChainPoker</h2>
              <p>Provably fair poker on the Cosmos blockchain.</p>
              {g.playerWallet.status !== "connected" && (
                <button
                  className="onboard-btn"
                  type="button"
                  onClick={g.connectWallet}
                  disabled={g.playerWallet.status === "connecting"}
                >
                  {g.playerWallet.status === "connecting" ? "Connecting..." : "Connect Wallet"}
                </button>
              )}
              {g.playerWallet.error && <p className="error-banner">{g.playerWallet.error}</p>}
              {g.tables.loading && !g.tables.data && <p className="placeholder">Loading tables...</p>}
              {g.filteredTableList.length > 0 && (
                <>
                  <p className="hint" style={{ marginTop: "0.5rem" }}>
                    {g.playerWallet.status === "connected" ? "Select a table to join" : "Select a table to watch"}
                  </p>
                  <ul className="table-list">
                    {g.filteredTableList.slice(0, 8).map((table) => (
                      <li key={table.tableId}>
                        <button
                          type="button"
                          className="table-row"
                          onClick={() => g.setSelectedTableId(table.tableId)}
                        >
                          <div>
                            <strong>#{table.tableId}{table.label ? ` ${table.label}` : ""}</strong>
                            <p>blinds {table.params.smallBlind}/{table.params.bigBlind}</p>
                          </div>
                          <div className="table-meta">
                            <span className={`badge ${statusTone(table.status)}`}>{table.status}</span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {g.filteredTableList.length === 0 && !g.tables.loading && (
                <p className="placeholder">No tables yet.</p>
              )}
              {g.playerWallet.status === "connected" && (
                <button
                  type="button"
                  className="topbar-btn"
                  style={{ marginTop: "0.5rem" }}
                  onClick={() => g.setShowCreateTableModal(true)}
                >
                  + Create Table
                </button>
              )}
            </div>
          </div>
        )}

        {/* Action banner — shown when watching a table but not yet playing */}
        {g.showActionBanner && (
          <div className="spectator-banner">
            {g.playerWallet.status !== "connected" ? (
              <>
                <span>Watching Table #{g.selectedTableId}</span>
                <button
                  type="button"
                  className="topbar-btn topbar-btn--accent"
                  onClick={g.connectWallet}
                  disabled={g.playerWallet.status === "connecting"}
                >
                  {g.playerWallet.status === "connecting" ? "Connecting..." : "Connect to Play"}
                </button>
              </>
            ) : (
              <>
                <span>Table #{g.selectedTableId}</span>
                <button
                  type="button"
                  className="topbar-btn topbar-btn--accent"
                  onClick={() => g.setSidebarOpen(true)}
                >
                  Take a Seat
                </button>
              </>
            )}
            <button
              type="button"
              className="topbar-btn"
              onClick={() => g.setSelectedTableId("")}
            >
              Lobby
            </button>
          </div>
        )}
      </main>

      {/* ─── Create Table Modal ─── */}
      {g.showCreateTableModal && (
        <div className="onboard-overlay" style={{ position: "fixed", inset: 0 }} onClick={(e) => { if (e.target === e.currentTarget) g.setShowCreateTableModal(false); }}>
          <div className="onboard-card">
            <h2>Create Table</h2>
            {renderCreateTableForm()}
            <button type="button" className="topbar-btn" style={{ marginTop: "0.5rem" }} onClick={() => g.setShowCreateTableModal(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ─── Sidebar ─── */}
      {g.sidebarOpen && <div className="sidebar-backdrop" onClick={() => g.setSidebarOpen(false)} />}
      <aside className={`game-sidebar${g.sidebarOpen ? " game-sidebar--open" : ""}`}>
        {/* Wallet Section */}
        <div className="game-sidebar__section">
          <h4>Wallet</h4>
          <p className="hint">
            Chain: {g.playerWallet.chainId}
          </p>
          {g.playerWallet.status === "connected" ? (
            <>
              <p style={{ fontSize: "0.76rem", wordBreak: "break-all" }}>{g.playerWallet.address}</p>
              <p className="hint">Seat: {g.playerSeat ? `#${g.playerSeat.seat}` : "Not seated"}</p>
            </>
          ) : (
            <button type="button" onClick={g.connectWallet} disabled={g.playerWallet.status === "connecting"}>
              Connect wallet
            </button>
          )}
          {g.playerWallet.error && <p className="error-banner">{g.playerWallet.error}</p>}
        </div>

        {/* Key Management */}
        {g.playerWallet.status === "connected" && g.playerKeyState === "locked" && (
          <div className="game-sidebar__section">
            <h4>Unlock Keys</h4>
            <p className="hint">Keys are encrypted. Enter passphrase to unlock.</p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="password"
                value={g.keyPassphrase}
                onChange={(e) => g.setKeyPassphrase(e.target.value)}
                placeholder="Passphrase"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); g.doUnlock(); } }}
              />
              <button type="button" onClick={g.doUnlock}>Unlock</button>
            </div>
            {g.keyError && <p className="error-banner">{g.keyError}</p>}
          </div>
        )}

        {g.playerWallet.status === "connected" && g.playerKeyState === "unlocked" && (
          <div className="game-sidebar__section">
            <h4>Key Protection</h4>
            <details>
              <summary style={{ cursor: "pointer", fontSize: "0.76rem", color: "var(--muted)" }}>Encrypt keys with passphrase</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.4rem" }}>
                <input type="password" value={g.protectPassphrase} onChange={(e) => g.setProtectPassphrase(e.target.value)} placeholder="New passphrase" />
                <input type="password" value={g.protectConfirm} onChange={(e) => g.setProtectConfirm(e.target.value)} placeholder="Confirm passphrase" />
                <button type="button" disabled={!g.protectPassphrase || g.protectPassphrase !== g.protectConfirm} onClick={() => {
                  void g.handleProtectKeys();
                }}>Encrypt Keys</button>
              </div>
              {g.protectStatus && <p className="hint">{g.protectStatus}</p>}
            </details>
          </div>
        )}

        {/* Seat / Leave / Rebuy */}
        {g.playerWallet.status === "connected" && g.selectedTableId && (
          <div className="game-sidebar__section">
            <h4>Table Actions</h4>
            {!g.playerSeat ? (
              <form className="seat-form" onSubmit={g.submitPlayerSeat}>
                <label>
                  Buy-In
                  <input required value={g.playerSeatForm.buyIn} onChange={(e) => g.onPlayerSeatInputChange("buyIn", e.target.value)} placeholder={g.selectedTable?.params.minBuyIn ?? "1000000"} disabled={g.playerSitSubmit.kind === "pending"} />
                </label>
                {g.selectedTable?.params?.passwordHash && (
                  <label>
                    Password
                    <input type="password" value={g.playerSeatForm.password} onChange={(e) => g.onPlayerSeatInputChange("password", e.target.value)} placeholder="Table password" disabled={g.playerSitSubmit.kind === "pending"} />
                  </label>
                )}
                <button type="submit" disabled={g.playerSitSubmit.kind === "pending" || g.playerWallet.status !== "connected"}>
                  {g.playerSitSubmit.kind === "pending" ? "Sitting..." : "Sit Down"}
                </button>
                {g.playerSitSubmit.message && <p className={g.playerSitSubmit.kind === "error" ? "error-banner" : "hint"}>{g.playerSitSubmit.message}</p>}
              </form>
            ) : (
              <>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button
                    type="button" className="btn-leave"
                    disabled={g.playerLeaveSubmit.kind === "pending" || g.playerWallet.status !== "connected" || !g.selectedTableId || Boolean(g.playerTableForSelected?.hand && g.playerSeat.inHand)}
                    onClick={g.submitPlayerLeave}
                  >
                    {g.playerLeaveSubmit.kind === "pending" ? "Leaving..." : "Leave Table"}
                  </button>
                </div>
                {g.playerLeaveSubmit.message && <p className={g.playerLeaveSubmit.kind === "error" ? "error-banner" : "hint"}>{g.playerLeaveSubmit.message}</p>}

                <div className="rebuy-row">
                  <input value={g.rebuyAmount} onChange={(e) => g.setRebuyAmount(e.target.value)} placeholder="Rebuy amount" inputMode="numeric" disabled={g.rebuySubmit.kind === "pending"} />
                  <button type="button" disabled={g.rebuySubmit.kind === "pending" || g.playerWallet.status !== "connected" || !g.selectedTableId || Boolean(g.playerTableForSelected?.hand && g.playerSeat.inHand)} onClick={g.submitRebuy}>
                    {g.rebuySubmit.kind === "pending" ? "..." : "Rebuy"}
                  </button>
                </div>
                {g.rebuySubmit.message && <p className={g.rebuySubmit.kind === "error" ? "error-banner" : "hint"}>{g.rebuySubmit.message}</p>}
              </>
            )}
          </div>
        )}

        {/* Faucet */}
        {g.playerWallet.status === "connected" && (
          <div className="game-sidebar__section">
            <h4>Faucet</h4>
            <button type="button" onClick={g.requestFaucet} disabled={g.faucetStatus.kind === "pending"}>
              {g.faucetStatus.kind === "pending" ? "Requesting..." : "Get Free CHIPS"}
            </button>
            {g.faucetStatus.message && <p className={g.faucetStatus.kind === "error" ? "error-banner" : "hint"}>{g.faucetStatus.message}</p>}
          </div>
        )}

        {/* Connection */}
        <div className="game-sidebar__section">
          <h4>Connection</h4>
          <div className="endpoint-row">
            <label htmlFor="sidebar-coordinator-url">Coordinator URL</label>
            <div className="endpoint-controls">
              <input
                id="sidebar-coordinator-url"
                value={g.coordinatorInput}
                onChange={(event) => g.setCoordinatorInput(event.target.value)}
                onKeyDown={g.onInputKeyDown}
                placeholder="http://127.0.0.1:8788"
                spellCheck={false}
              />
              <button type="button" onClick={g.applyCoordinatorBase}>Set</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.4rem" }}>
            <span className={`dot ${g.health.error ? "status-closed" : "status-open"}`} />
            <span className="hint">{g.health.error ? "Unavailable" : "Connected"}</span>
            <span className={`dot ${wsTone(g.wsStatus)}`} style={{ marginLeft: "0.5rem" }} />
            <span className="hint">WS: {g.wsStatus}</span>
          </div>
        </div>
      </aside>

      {/* ─── Footer — Chat ─── */}
      <footer className="game-footer">
        {renderChat()}
      </footer>
    </div>
  );
}
