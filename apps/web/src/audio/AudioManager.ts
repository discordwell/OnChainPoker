/**
 * AudioManager — Web Audio API singleton with programmatic sound synthesis.
 * No external audio files needed; all sounds are generated from oscillators and noise.
 *
 * Lazy-initializes AudioContext on first user gesture (browser autoplay policy).
 */

const STORAGE_KEY = "felt.audio";

export type SoundId =
  | "deal"
  | "cardFlip"
  | "chipClick"
  | "check"
  | "call"
  | "fold"
  | "raise"
  | "allIn"
  | "yourTurn"
  | "winSmall"
  | "winBig"
  | "phaseChange";

interface AudioState {
  muted: boolean;
  volume: number; // 0-1
}

class AudioManagerImpl {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _state: AudioState;
  private _initialized = false;

  constructor() {
    const saved = localStorage.getItem(STORAGE_KEY);
    this._state = saved
      ? JSON.parse(saved)
      : { muted: false, volume: 0.6 };
  }

  /** Initialize on first user interaction */
  private init() {
    if (this._initialized) return;
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._state.muted ? 0 : this._state.volume;
      this.masterGain.connect(this.ctx.destination);
      this._initialized = true;
    } catch {
      // Web Audio not supported
    }
  }

  private ensureCtx(): AudioContext | null {
    if (!this._initialized) this.init();
    if (this.ctx?.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  get muted() { return this._state.muted; }
  get volume() { return this._state.volume; }

  setMuted(muted: boolean) {
    this._state.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : this._state.volume;
    }
    this.save();
  }

  setVolume(v: number) {
    this._state.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && !this._state.muted) {
      this.masterGain.gain.value = this._state.volume;
    }
    this.save();
  }

  toggleMute() {
    this.setMuted(!this._state.muted);
  }

  private save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state));
  }

  // ─── Sound Synthesis ───

  play(id: SoundId) {
    const ctx = this.ensureCtx();
    if (!ctx || !this.masterGain) return;

    switch (id) {
      case "deal": this.playDeal(ctx); break;
      case "cardFlip": this.playCardFlip(ctx); break;
      case "chipClick": this.playChipClick(ctx); break;
      case "check": this.playCheck(ctx); break;
      case "call": this.playCall(ctx); break;
      case "fold": this.playFold(ctx); break;
      case "raise": this.playRaise(ctx); break;
      case "allIn": this.playAllIn(ctx); break;
      case "yourTurn": this.playYourTurn(ctx); break;
      case "winSmall": this.playWinSmall(ctx); break;
      case "winBig": this.playWinBig(ctx); break;
      case "phaseChange": this.playPhaseChange(ctx); break;
    }
  }

  /** Short percussive snap — card sliding onto felt */
  private playDeal(ctx: AudioContext) {
    const t = ctx.currentTime;
    const noise = this.createNoise(ctx, 0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3000;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    noise.connect(filter).connect(gain).connect(this.masterGain!);
  }

  /** Quick snap + tonal pop — card flipping face-up */
  private playCardFlip(ctx: AudioContext) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.04);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** Ceramic chip click — short high-freq burst */
  private playChipClick(ctx: AudioContext) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 2200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(t);
    osc.stop(t + 0.05);

    // Add a second harmonic for richness
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 4400;
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.08, t);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc2.connect(gain2).connect(this.masterGain!);
    osc2.start(t);
    osc2.stop(t + 0.03);
  }

  /** Soft tap — check/knock */
  private playCheck(ctx: AudioContext) {
    const t = ctx.currentTime;
    const noise = this.createNoise(ctx, 0.04);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    noise.connect(filter).connect(gain).connect(this.masterGain!);
  }

  /** Chip slide — call */
  private playCall(ctx: AudioContext) {
    this.playChipClick(ctx);
  }

  /** Cards sliding away — fold */
  private playFold(ctx: AudioContext) {
    const t = ctx.currentTime;
    const noise = this.createNoise(ctx, 0.12);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2000, t);
    filter.frequency.exponentialRampToValueAtTime(200, t + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    noise.connect(filter).connect(gain).connect(this.masterGain!);
  }

  /** Aggressive chip push — raise */
  private playRaise(ctx: AudioContext) {
    const t = ctx.currentTime;
    // Multiple chip clicks in rapid succession
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.04;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 2000 + i * 400;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.18, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.05);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.05);
    }
  }

  /** Dramatic chip cascade — all-in */
  private playAllIn(ctx: AudioContext) {
    const t = ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const delay = i * 0.035;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 1800 + Math.random() * 1200;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.15, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.06);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.06);
    }
    // Low rumble undertone
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 80;
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.1, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    sub.connect(subGain).connect(this.masterGain!);
    sub.start(t);
    sub.stop(t + 0.3);
  }

  /** Attention bell — your turn to act */
  private playYourTurn(ctx: AudioContext) {
    const t = ctx.currentTime;
    const freqs = [880, 1100];
    for (let i = 0; i < freqs.length; i++) {
      const delay = i * 0.12;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freqs[i]!;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.2, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.2);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.2);
    }
  }

  /** Ascending tone — small win */
  private playWinSmall(ctx: AudioContext) {
    const t = ctx.currentTime;
    const notes = [523, 659, 784]; // C5, E5, G5
    for (let i = 0; i < notes.length; i++) {
      const delay = i * 0.1;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = notes[i]!;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.2, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.25);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.25);
    }
  }

  /** Triumphant fanfare — big win */
  private playWinBig(ctx: AudioContext) {
    const t = ctx.currentTime;
    const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
    for (let i = 0; i < notes.length; i++) {
      const delay = i * 0.1;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = notes[i]!;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.25, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.01, t + delay + 0.4);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.4);
    }
    // Shimmer overlay
    for (let i = 0; i < 8; i++) {
      const delay = 0.05 + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 2000 + Math.random() * 2000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.1);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t + delay);
      osc.stop(t + delay + 0.1);
    }
  }

  /** Subtle transition chime — phase change (flop/turn/river) */
  private playPhaseChange(ctx: AudioContext) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.15);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // ─── Utilities ───

  /** Create a white noise source */
  private createNoise(ctx: AudioContext, duration: number): AudioBufferSourceNode {
    const bufferSize = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.start(ctx.currentTime);
    source.stop(ctx.currentTime + duration);
    return source;
  }
}

/** Global singleton */
export const audioManager = new AudioManagerImpl();
