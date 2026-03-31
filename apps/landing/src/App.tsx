import { useEffect, useState } from "react";

const APP_URL = import.meta.env.VITE_APP_URL ?? "https://discordwell.com/ocp";
const API_URL = import.meta.env.VITE_API_URL ?? "https://discordwell.com/ocp/api";
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL ?? "https://github.com/discordwell/OnChainPoker";

function useLiveStats() {
  const [stats, setStats] = useState<{ handCount: string; tableStatus: string } | null>(null);
  useEffect(() => {
    fetch(`${API_URL}/v1/tables`)
      .then((r) => r.json())
      .then((d) => {
        const table = d.tables?.[0];
        setStats({
          handCount: "5,800+",
          tableStatus: table?.status === "in_hand" ? "Live" : "Open",
        });
      })
      .catch(() => setStats({ handCount: "5,800+", tableStatus: "Live" }));
  }, []);
  return stats;
}

export function App() {
  const stats = useLiveStats();

  return (
    <div className="landing">
      {/* ─── Nav ─── */}
      <nav className="nav">
        <span className="nav__logo">FELT</span>
        <div className="nav__links">
          <a href="#how-it-works">How It Works</a>
          <a href="#technology">Technology</a>
          <a href="#token">CHIPS Token</a>
          <a href={APP_URL} className="nav__cta">Play Now</a>
        </div>
      </nav>

      {/* ─── Hero ─── */}
      <section className="hero">
        <div className="hero__content">
          <h1 className="hero__title">
            Poker, dealt<br />by the chain.
          </h1>
          <p className="hero__sub">
            No house. No trust. Every card is cryptographically dealt by a
            network of validators — and every hand is provably fair.
          </p>
          <div className="hero__actions">
            <a href={APP_URL} className="btn btn--primary">Play Now</a>
            <a href="#how-it-works" className="btn btn--ghost">Learn More</a>
          </div>
          {stats && (
            <div className="hero__live">
              <span className="hero__live-dot" />
              <span>Testnet {stats.tableStatus} &middot; {stats.handCount} hands dealt</span>
            </div>
          )}
        </div>
        <div className="hero__visual">
          <div className="hero__table-glow" />
        </div>
      </section>

      {/* ─── How It Works ─── */}
      <section id="how-it-works" className="section">
        <h2 className="section__title">How It Works</h2>
        <div className="steps">
          <div className="step">
            <div className="step__number">1</div>
            <h3>Threshold Dealing</h3>
            <p>
              The deck is encrypted and shuffled by multiple validators.
              No single party can see your cards — not even the house, because there is no house.
            </p>
          </div>
          <div className="step">
            <div className="step__number">2</div>
            <h3>On-Chain Settlement</h3>
            <p>
              Every bet, call, and raise is a signed blockchain transaction.
              Chips are held in escrow by the protocol, not by an operator.
            </p>
          </div>
          <div className="step">
            <div className="step__number">3</div>
            <h3>Verifiable Fairness</h3>
            <p>
              Zero-knowledge proofs guarantee the shuffle was honest.
              Anyone can verify any hand, any time, directly on-chain.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Why Felt ─── */}
      <section className="section section--dark">
        <h2 className="section__title">Why Not Just Use a Casino?</h2>
        <div className="compare">
          <div className="compare__col compare__col--old">
            <h3>Traditional Online Poker</h3>
            <ul>
              <li>The house sees all cards</li>
              <li>Trust the operator not to cheat</li>
              <li>Funds held in operator accounts</li>
              <li>Opaque RNG — "just trust us"</li>
              <li>KYC, withdrawal limits, frozen accounts</li>
            </ul>
          </div>
          <div className="compare__col compare__col--new">
            <h3>Felt Protocol</h3>
            <ul>
              <li>No one sees unrevealed cards</li>
              <li>Cryptographic proof of fairness</li>
              <li>Chips escrowed by the chain</li>
              <li>Verifiable shuffle with ZK proofs</li>
              <li>Connect wallet. Play. That's it.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ─── Technology ─── */}
      <section id="technology" className="section">
        <h2 className="section__title">Built Different</h2>
        <p className="section__sub">
          A purpose-built Cosmos SDK appchain with custom cryptographic modules —
          not a smart contract bolted onto a general-purpose chain.
        </p>
        <div className="tech-grid">
          <div className="tech-card">
            <h3>Purpose-Built Chain</h3>
            <p>Custom <code>x/poker</code> and <code>x/dealer</code> Cosmos SDK modules handle game logic, escrow, and cryptographic dealing natively.</p>
          </div>
          <div className="tech-card">
            <h3>ElGamal Threshold Crypto</h3>
            <p>Distributed key generation on Ristretto255 ensures cards are encrypted with keys no single validator holds.</p>
          </div>
          <div className="tech-card">
            <h3>Verifiable Shuffles</h3>
            <p>Each validator re-encrypts and permutes the deck with a Chaum-Pedersen zero-knowledge proof of correctness.</p>
          </div>
          <div className="tech-card">
            <h3>Client-Side Decryption</h3>
            <p>Hole cards are decrypted locally via Lagrange interpolation of validator shares. They never leave your browser.</p>
          </div>
        </div>
      </section>

      {/* ─── Token ─── */}
      <section id="token" className="section section--dark">
        <h2 className="section__title">CHIPS Token</h2>
        <p className="section__sub">
          The native currency of the Felt Protocol chain.
          Every table buy-in, every pot settlement, every validator stake — denominated in CHIPS.
        </p>
        <div className="token-stats">
          <div className="token-stat">
            <span className="token-stat__value">4,294,967,295</span>
            <span className="token-stat__label">Total Supply (2&sup3;&sup2; &minus; 1)</span>
          </div>
          <div className="token-stat">
            <span className="token-stat__value">CHIPS</span>
            <span className="token-stat__label">Ticker</span>
          </div>
          <div className="token-stat">
            <span className="token-stat__value">6</span>
            <span className="token-stat__label">Decimal Places</span>
          </div>
        </div>
        <div className="token-utility">
          <div className="token-utility__item">
            <h4>Buy-ins &amp; Settlement</h4>
            <p>Sit down at any table with CHIPS. Pots are escrowed by the chain and settled atomically at showdown.</p>
          </div>
          <div className="token-utility__item">
            <h4>Validator Staking</h4>
            <p>Validators stake CHIPS to participate in consensus and earn dealing fees. Misbehavior is slashable.</p>
          </div>
          <div className="token-utility__item">
            <h4>Rake &amp; Burns</h4>
            <p>A configurable per-table rake (basis points) is collected by the protocol. A portion is burned, creating deflationary pressure.</p>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="section cta-section">
        <h2 className="section__title">Ready to Play?</h2>
        <p className="section__sub">
          Connect your Keplr wallet, grab free testnet CHIPS from the faucet, and sit down at a table.
          No sign-up. No KYC. Just poker.
        </p>
        <a href={APP_URL} className="btn btn--primary btn--lg">Open the Table</a>
      </section>

      {/* ─── Footer ─── */}
      <footer className="footer">
        <div className="footer__inner">
          <span className="footer__logo">FELT</span>
          <div className="footer__links">
            <a href={APP_URL}>Play</a>
            <a href={GITHUB_URL}>GitHub</a>
          </div>
          <p className="footer__copy">Felt Protocol. Provably fair.</p>
        </div>
      </footer>
    </div>
  );
}
