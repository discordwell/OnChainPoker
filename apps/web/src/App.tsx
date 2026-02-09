import { ethers } from "ethers";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ENV, formatAddr, isConfigured, OCP_TOKEN_ABI, POKER_VAULT_ABI } from "./contracts";
import { AppchainDealerDemo } from "./AppchainDealer";

type HandPayload = {
  handId: string;
  players: string[];
  deltas: string[];
  deadline: number;
};

function parseHandPayload(raw: string): { payload?: HandPayload; error?: string } {
  try {
    const parsed = JSON.parse(raw) as Partial<HandPayload>;
    if (typeof parsed.handId !== "string" || parsed.handId.length === 0) {
      return { error: "handId must be a string" };
    }
    if (!Array.isArray(parsed.players) || parsed.players.length === 0) {
      return { error: "players must be a non-empty array" };
    }
    if (!Array.isArray(parsed.deltas) || parsed.deltas.length === 0) {
      return { error: "deltas must be a non-empty array" };
    }
    if (parsed.players.length !== parsed.deltas.length) {
      return { error: "players and deltas lengths must match" };
    }
    if (typeof parsed.deadline !== "number" || !Number.isFinite(parsed.deadline)) {
      return { error: "deadline must be a unix timestamp (seconds)" };
    }
    return {
      payload: {
        handId: parsed.handId,
        players: parsed.players.map(String),
        deltas: parsed.deltas.map(String),
        deadline: parsed.deadline
      }
    };
  } catch {
    return { error: "invalid JSON" };
  }
}

function toBytes32HandId(handId: string): string {
  const trimmed = handId.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  return ethers.keccak256(ethers.toUtf8Bytes(trimmed));
}

function parseDeltaToWei(delta: string, decimals: number): bigint {
  const trimmed = delta.trim();
  if (trimmed.length === 0) throw new Error("empty delta");
  if (trimmed.startsWith("-")) return -ethers.parseUnits(trimmed.slice(1), decimals);
  return ethers.parseUnits(trimmed, decimals);
}

function normalizeSigs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  try {
    const asJson = JSON.parse(trimmed);
    if (Array.isArray(asJson)) return asJson.map(String);
  } catch {
    // fall through
  }
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function App() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [address, setAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [tokenSymbol, setTokenSymbol] = useState<string>("OCP");
  const [tokenDecimals, setTokenDecimals] = useState<number>(18);
  const [tokenOwner, setTokenOwner] = useState<string>("");
  const [walletBal, setWalletBal] = useState<bigint>(0n);
  const [vaultBal, setVaultBal] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [withdrawDelay, setWithdrawDelay] = useState<bigint>(0n);
  const [withdrawReqAmt, setWithdrawReqAmt] = useState<bigint>(0n);
  const [withdrawReqAt, setWithdrawReqAt] = useState<bigint>(0n);

  const [depositAmt, setDepositAmt] = useState<string>("10");
  const [withdrawAmt, setWithdrawAmt] = useState<string>("5");

  const [mintTo, setMintTo] = useState<string>("");
  const [mintAmt, setMintAmt] = useState<string>("100");

  const [handJson, setHandJson] = useState<string>(() => {
    const now = Math.floor(Date.now() / 1000);
    return JSON.stringify(
      {
        handId: "hand-1",
        players: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"],
        deltas: ["10", "-10"],
        deadline: now + 3600
      },
      null,
      2
    );
  });
  const [sigOut, setSigOut] = useState<string>("");
  const [sigList, setSigList] = useState<string>("");
  const [resultHashPreview, setResultHashPreview] = useState<string>("");
  const [noncePreview, setNoncePreview] = useState<string>("");

  const configured = isConfigured();
  const chainOk = ENV.expectedChainId == null || chainId == null || chainId === ENV.expectedChainId;
  const isOwner =
    address &&
    tokenOwner &&
    address.toLowerCase() === tokenOwner.toLowerCase();

  const tokenContract = useMemo(() => {
    if (!provider || !configured) return null;
    return new ethers.Contract(ENV.tokenAddress, OCP_TOKEN_ABI, provider);
  }, [provider, configured]);

  const vaultContract = useMemo(() => {
    if (!provider || !configured) return null;
    return new ethers.Contract(ENV.vaultAddress, POKER_VAULT_ABI, provider);
  }, [provider, configured]);

  const tokenWrite = useMemo(() => {
    if (!signer || !configured) return null;
    return new ethers.Contract(ENV.tokenAddress, OCP_TOKEN_ABI, signer);
  }, [signer, configured]);

  const vaultWrite = useMemo(() => {
    if (!signer || !configured) return null;
    return new ethers.Contract(ENV.vaultAddress, POKER_VAULT_ABI, signer);
  }, [signer, configured]);

  const connect = useCallback(async () => {
    setError("");
    setStatus("");
    if (!(window as any).ethereum) {
      setError("No injected wallet found (install MetaMask or a compatible wallet).");
      return;
    }

    const p = new ethers.BrowserProvider((window as any).ethereum);
    await p.send("eth_requestAccounts", []);
    const s = await p.getSigner();
    const addr = await s.getAddress();
    const net = await p.getNetwork();

    setProvider(p);
    setSigner(s);
    setAddress(addr);
    setMintTo(addr);
    setChainId(Number(net.chainId));
  }, []);

  const disconnect = useCallback(() => {
    setProvider(null);
    setSigner(null);
    setAddress("");
    setChainId(null);
    setStatus("");
    setError("");
    setMintTo("");
    setMintAmt("100");
    setSigOut("");
    setSigList("");
    setResultHashPreview("");
    setNoncePreview("");
    setWithdrawDelay(0n);
    setWithdrawReqAmt(0n);
    setWithdrawReqAt(0n);
  }, []);

  const refresh = useCallback(async () => {
    if (!tokenContract || !vaultContract || !address) return;
    const [sym, dec, own, wb, vb, al, wd, wr] = await Promise.all([
      tokenContract.symbol().catch(() => tokenSymbol),
      tokenContract.decimals().catch(() => tokenDecimals),
      tokenContract.owner().catch(() => ""),
      tokenContract.balanceOf(address),
      vaultContract.balanceOf(address),
      tokenContract.allowance(address, ENV.vaultAddress),
      vaultContract.withdrawDelay().catch(() => 0n),
      vaultContract.withdrawRequests(address).catch(() => [0n, 0n])
    ]);

    setTokenSymbol(String(sym));
    setTokenDecimals(Number(dec));
    setTokenOwner(String(own));
    setWalletBal(BigInt(wb));
    setVaultBal(BigInt(vb));
    setAllowance(BigInt(al));
    setWithdrawDelay(BigInt(wd));
    const wrAmt = (wr as any)?.amount ?? (wr as any)?.[0] ?? 0;
    const wrAt = (wr as any)?.availableAt ?? (wr as any)?.[1] ?? 0;
    setWithdrawReqAmt(BigInt(wrAmt));
    setWithdrawReqAt(BigInt(wrAt));
  }, [tokenContract, vaultContract, address, tokenSymbol, tokenDecimals]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fmt = useCallback(
    (v: bigint) => `${ethers.formatUnits(v, tokenDecimals)} ${tokenSymbol}`,
    [tokenDecimals, tokenSymbol]
  );

  const approveIfNeeded = useCallback(
    async (amountWei: bigint) => {
      if (!tokenWrite) throw new Error("wallet not connected");
      if (allowance >= amountWei) return;
      setStatus("Approving token allowance…");
      const tx = await tokenWrite.approve(ENV.vaultAddress, amountWei);
      setStatus(`Approve tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Approve confirmed.");
    },
    [tokenWrite, allowance]
  );

  const onDeposit = useCallback(async () => {
    try {
      setError("");
      if (!vaultWrite) throw new Error("wallet not connected");
      const amtWei = ethers.parseUnits(depositAmt, tokenDecimals);
      await approveIfNeeded(amtWei);
      setStatus("Depositing to vault…");
      const tx = await vaultWrite.deposit(amtWei);
      setStatus(`Deposit tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Deposit confirmed.");
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultWrite, depositAmt, tokenDecimals, approveIfNeeded, refresh]);

  const onWithdraw = useCallback(async () => {
    try {
      setError("");
      if (!vaultWrite) throw new Error("wallet not connected");
      const amtWei = ethers.parseUnits(withdrawAmt, tokenDecimals);
      if (withdrawDelay === 0n) {
        setStatus("Withdrawing from vault…");
        const tx = await vaultWrite.withdraw(amtWei);
        setStatus(`Withdraw tx sent: ${tx.hash}`);
        await tx.wait();
        setStatus("Withdraw confirmed.");
      } else {
        setStatus("Requesting withdraw…");
        const tx = await vaultWrite.requestWithdraw(amtWei);
        setStatus(`Withdraw request tx sent: ${tx.hash}`);
        await tx.wait();
        setStatus("Withdraw requested. Execute after the delay.");
      }
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultWrite, withdrawAmt, tokenDecimals, refresh, withdrawDelay]);

  const onExecuteWithdraw = useCallback(async () => {
    try {
      setError("");
      if (!vaultWrite) throw new Error("wallet not connected");
      setStatus("Executing withdraw…");
      const tx = await vaultWrite.executeWithdraw();
      setStatus(`Execute tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Withdraw executed.");
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultWrite, refresh]);

  const onCancelWithdraw = useCallback(async () => {
    try {
      setError("");
      if (!vaultWrite) throw new Error("wallet not connected");
      setStatus("Cancelling withdraw request…");
      const tx = await vaultWrite.cancelWithdraw();
      setStatus(`Cancel tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Withdraw request cancelled.");
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultWrite, refresh]);

  const onMint = useCallback(async () => {
    try {
      setError("");
      if (!tokenWrite) throw new Error("wallet not connected");
      if (!ethers.isAddress(mintTo)) throw new Error("mintTo must be a valid address");
      const amtWei = ethers.parseUnits(mintAmt, tokenDecimals);
      setStatus("Minting test OCP…");
      const tx = await tokenWrite.mint(mintTo, amtWei);
      setStatus(`Mint tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Mint confirmed.");
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [tokenWrite, mintTo, mintAmt, tokenDecimals, refresh]);

  const previewHand = useCallback(async () => {
    setError("");
    setResultHashPreview("");
    setNoncePreview("");
    setSigOut("");
    if (!vaultContract || !address) return;

    const { payload, error: parseErr } = parseHandPayload(handJson);
    if (!payload) {
      setError(parseErr ?? "invalid payload");
      return;
    }

    for (const p of payload.players) {
      if (!ethers.isAddress(p)) throw new Error(`invalid address: ${p}`);
    }

    const handId = toBytes32HandId(payload.handId);
    const deltasWei = payload.deltas.map((d) => parseDeltaToWei(d, tokenDecimals));
    const resultHash = await vaultContract.computeResultHash(handId, payload.players, deltasWei);
    const nonce = await vaultContract.nonces(address);
    setResultHashPreview(String(resultHash));
    setNoncePreview(String(nonce));
  }, [vaultContract, address, handJson, tokenDecimals]);

  const onSign = useCallback(async () => {
    try {
      setError("");
      setSigOut("");
      if (!vaultContract || !signer || !address) throw new Error("wallet not connected");

      const { payload, error: parseErr } = parseHandPayload(handJson);
      if (!payload) throw new Error(parseErr ?? "invalid payload");

      for (const p of payload.players) {
        if (!ethers.isAddress(p)) throw new Error(`invalid address: ${p}`);
      }

      const pNet = await (provider ?? (signer as any).provider)?.getNetwork?.();
      const netChainId = pNet?.chainId != null ? Number(pNet.chainId) : chainId ?? 0;

      const handId = toBytes32HandId(payload.handId);
      const deltasWei = payload.deltas.map((d) => parseDeltaToWei(d, tokenDecimals));
      const resultHash = await vaultContract.computeResultHash(handId, payload.players, deltasWei);
      const nonce = await vaultContract.nonces(address);

      const signature = await (signer as any).signTypedData(
        {
          name: "PokerVault",
          version: "1",
          chainId: netChainId,
          verifyingContract: ENV.vaultAddress
        },
        {
          HandResultApproval: [
            { name: "resultHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" }
          ]
        },
        { resultHash, nonce, deadline: BigInt(payload.deadline) }
      );

      setResultHashPreview(String(resultHash));
      setNoncePreview(String(nonce));
      setSigOut(signature);
      setStatus("Signature created. Share it with the hand submitter.");
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultContract, signer, address, handJson, tokenDecimals, provider, chainId]);

  const onSubmit = useCallback(async () => {
    try {
      setError("");
      if (!vaultWrite || !vaultContract) throw new Error("wallet not connected");

      const { payload, error: parseErr } = parseHandPayload(handJson);
      if (!payload) throw new Error(parseErr ?? "invalid payload");
      const sigs = normalizeSigs(sigList);
      if (sigs.length !== payload.players.length) {
        throw new Error(`need ${payload.players.length} signatures, got ${sigs.length}`);
      }

      const handId = toBytes32HandId(payload.handId);
      const deltasWei = payload.deltas.map((d) => parseDeltaToWei(d, tokenDecimals));

      setStatus("Submitting hand result…");
      const tx = await vaultWrite.applyHandResultWithSignatures(
        handId,
        payload.players,
        deltasWei,
        BigInt(payload.deadline),
        sigs
      );
      setStatus(`Submit tx sent: ${tx.hash}`);
      await tx.wait();
      setStatus("Hand result applied.");
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }, [vaultWrite, vaultContract, handJson, sigList, tokenDecimals, refresh]);

  return (
    <div className="container">
      <div className="topbar animateIn">
        <div className="brand">
          <h1>OnChainPoker</h1>
          <p>
            Escrowed buy-ins. Signed settlements. <span className="mono">OCP</span> chips.
          </p>
        </div>
        <div className="row">
          {address ? (
            <>
              <span className="pill">{formatAddr(address)}</span>
              <span className={`pill ${chainOk ? "ok" : "danger"}`}>
                chain {chainId ?? "?"}
                {!chainOk ? " (mismatch)" : ""}
              </span>
              <button className="btn btnDanger" onClick={disconnect}>
                Clear Session
              </button>
            </>
          ) : (
            <button className="btn btnPrimary" onClick={connect}>
              Connect Wallet
            </button>
          )}
        </div>
      </div>

      {!configured ? (
        <div className="card animateIn">
          <div className="cardHeader">
            <h2>Config Needed</h2>
            <div className="hint">
              Set <span className="mono">VITE_TOKEN_ADDRESS</span> and <span className="mono">VITE_VAULT_ADDRESS</span>
            </div>
          </div>
          <div className="kv">
            <div>token</div>
            <div className="danger">{ENV.tokenAddress || "(empty)"}</div>
            <div>vault</div>
            <div className="danger">{ENV.vaultAddress || "(empty)"}</div>
            <div>expected</div>
            <div>{ENV.expectedChainId ?? "(any)"}</div>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Tip: after deploying, check <span className="mono">deployments/&lt;network&gt;-&lt;chainId&gt;.json</span>.
          </p>
        </div>
      ) : null}

      <div className="grid">
        <div className="card span6 animateIn">
          <div className="cardHeader">
            <h2>Balances</h2>
            <div className="hint">Wallet + vault ledger</div>
          </div>
          {address ? (
            <div className="kv">
              <div>wallet</div>
              <div>{fmt(walletBal)}</div>
              <div>vault</div>
              <div>{fmt(vaultBal)}</div>
              <div>allow</div>
              <div>{fmt(allowance)}</div>
            </div>
          ) : (
            <div className="hint">Connect a wallet to load balances.</div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => void refresh()} disabled={!address}>
              Refresh
            </button>
          </div>
        </div>

        <div className="card span6 animateIn">
          <div className="cardHeader">
            <h2>Vault</h2>
            <div className="hint">
              token: <span className="mono">{tokenSymbol}</span>
            </div>
          </div>

          <div className="field">
            <label>Deposit ({tokenSymbol})</label>
            <div className="row">
              <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} placeholder="10" />
              <button className="btn btnPrimary" onClick={() => void onDeposit()} disabled={!address || !chainOk}>
                Approve + Deposit
              </button>
            </div>
          </div>

          <div className="field">
            <label>
              Withdraw ({tokenSymbol}){" "}
              {withdrawDelay !== 0n ? (
                <span className="hint">
                  delay: <span className="mono">{withdrawDelay.toString()}s</span>
                </span>
              ) : null}
            </label>
            <div className="row">
              <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} placeholder="5" />
              <button className="btn" onClick={() => void onWithdraw()} disabled={!address || !chainOk}>
                {withdrawDelay === 0n ? "Withdraw" : "Request"}
              </button>
              {withdrawDelay !== 0n ? (
                <>
                  <button
                    className="btn btnPrimary"
                    onClick={() => void onExecuteWithdraw()}
                    disabled={!address || !chainOk || withdrawReqAmt === 0n}
                    title={withdrawReqAmt === 0n ? "No pending withdraw request" : "Execute once the delay has elapsed"}
                  >
                    Execute
                  </button>
                  <button
                    className="btn btnDanger"
                    onClick={() => void onCancelWithdraw()}
                    disabled={!address || !chainOk || withdrawReqAmt === 0n}
                    title={withdrawReqAmt === 0n ? "No pending withdraw request" : "Cancel the pending request"}
                  >
                    Cancel
                  </button>
                </>
              ) : null}
            </div>
            {withdrawDelay !== 0n && withdrawReqAmt !== 0n ? (
              <div className="hint" style={{ marginTop: 6 }}>
                pending: <span className="mono">{fmt(withdrawReqAmt)}</span>{" "}
                availableAt:{" "}
                <span className="mono">
                  {withdrawReqAt.toString()}
                  {withdrawReqAt !== 0n ? ` (${new Date(Number(withdrawReqAt) * 1000).toLocaleString()})` : ""}
                </span>
              </div>
            ) : withdrawDelay !== 0n ? (
              <div className="hint" style={{ marginTop: 6 }}>
                Request first, then execute after the delay. Others can submit already-signed settlements during this window.
              </div>
            ) : null}
          </div>

          <div className="field">
            <label>
              Mint (token owner only){" "}
              {tokenOwner ? (
                <span className="hint">
                  owner: <span className={`mono ${isOwner ? "ok" : ""}`}>{formatAddr(tokenOwner)}</span>
                </span>
              ) : null}
            </label>
            <div className="row">
              <input
                value={mintTo}
                onChange={(e) => setMintTo(e.target.value)}
                placeholder={address ? address : "0x…"}
              />
              <input value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} placeholder="100" />
              <button
                className="btn btnPrimary"
                onClick={() => void onMint()}
                disabled={!address || !chainOk || !isOwner}
                title={!isOwner ? "Connect the token owner address to mint" : "Mint tokens"}
              >
                Mint
              </button>
            </div>
          </div>
        </div>

        <div className="card animateIn">
          <div className="cardHeader">
            <h2>Hand Settlement</h2>
            <div className="hint">Players sign EIP-712 approvals; anyone can submit.</div>
          </div>

          <div className="field">
            <label>Hand Payload (JSON)</label>
            <textarea value={handJson} onChange={(e) => setHandJson(e.target.value)} />
            <div className="row">
              <button className="btn" onClick={() => void previewHand()} disabled={!address || !chainOk}>
                Preview Hash/Nonce
              </button>
              <button className="btn btnPrimary" onClick={() => void onSign()} disabled={!address || !chainOk}>
                Sign (as connected wallet)
              </button>
            </div>
            {resultHashPreview ? (
              <div className="kv">
                <div>handId</div>
                <div>{toBytes32HandId(parseHandPayload(handJson).payload?.handId ?? "")}</div>
                <div>hash</div>
                <div>{resultHashPreview}</div>
                <div>nonce</div>
                <div>{noncePreview}</div>
              </div>
            ) : null}
          </div>

          <div className="field">
            <label>Signature Output</label>
            <input value={sigOut} readOnly placeholder="0x…" />
          </div>

          <div className="field">
            <label>Signatures (JSON array or whitespace-separated; order must match players[])</label>
            <textarea value={sigList} onChange={(e) => setSigList(e.target.value)} placeholder='["0x…","0x…"]' />
            <div className="row">
              <button className="btn btnPrimary" onClick={() => void onSubmit()} disabled={!address || !chainOk}>
                Submit Hand Result
              </button>
            </div>
          </div>
        </div>
      </div>

      <AppchainDealerDemo />

      {status ? (
        <p className="hint animateIn" style={{ marginTop: 14 }}>
          <span className="ok">status</span>: <span className="mono">{status}</span>
        </p>
      ) : null}
      {error ? (
        <p className="hint animateIn" style={{ marginTop: 10 }}>
          <span className="danger">error</span>: <span className="mono">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
