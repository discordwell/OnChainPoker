export function App() {
  return (
    <div className="landing">
      {/* ─── Nav ─── */}
      <nav className="nav">
        <span className="nav__logo">FELT</span>
        <div className="nav__links">
          <a href="#how-it-works">How It Works</a>
          <a href="#technology">Technology</a>
          <a href="#token">CHIPS Token</a>
          <a href="https://discordwell.com/ocp" className="nav__cta">Play Now</a>
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
            <a href="https://discordwell.com/ocp" className="btn btn--primary">Play Now</a>
            <a href="#how-it-works" className="btn btn--ghost">Learn More</a>
          </div>
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

      {/* ─── Technology ─── */}
      <section id="technology" className="section section--dark">
        <h2 className="section__title">Built Different</h2>
        <div className="tech-grid">
          <div className="tech-card">
            <h3>Purpose-Built Chain</h3>
            <p>A custom Cosmos SDK appchain optimized for poker — not a smart contract on a general-purpose chain.</p>
          </div>
          <div className="tech-card">
            <h3>ElGamal Threshold Crypto</h3>
            <p>Distributed key generation with Ristretto255 ensures cards are encrypted with keys no single party holds.</p>
          </div>
          <div className="tech-card">
            <h3>Verifiable Shuffles</h3>
            <p>Each validator re-encrypts and permutes the deck with a zero-knowledge proof of correctness.</p>
          </div>
          <div className="tech-card">
            <h3>Client-Side Decryption</h3>
            <p>Your hole cards are decrypted locally in your browser. They never touch a server.</p>
          </div>
        </div>
      </section>

      {/* ─── Token ─── */}
      <section id="token" className="section">
        <h2 className="section__title">CHIPS Token</h2>
        <p className="section__sub">
          The native currency of the Felt Protocol chain.
          Used for buy-ins, settlements, and validator staking.
        </p>
        <div className="token-stats">
          <div className="token-stat">
            <span className="token-stat__value">CHIPS</span>
            <span className="token-stat__label">Display Denomination</span>
          </div>
          <div className="token-stat">
            <span className="token-stat__value">uchips</span>
            <span className="token-stat__label">Base Denomination</span>
          </div>
          <div className="token-stat">
            <span className="token-stat__value">6</span>
            <span className="token-stat__label">Decimal Places</span>
          </div>
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer className="footer">
        <div className="footer__inner">
          <span className="footer__logo">FELT</span>
          <div className="footer__links">
            <a href="https://discordwell.com/ocp">Play</a>
            <a href="https://github.com/onchainpoker">GitHub</a>
          </div>
          <p className="footer__copy">Felt Protocol. Provably fair.</p>
        </div>
      </footer>
    </div>
  );
}
