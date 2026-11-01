import { createSoundBank, type SoundBank } from '../audio/bank';
import { bakeNoise, bakeYardIR, wavBase64 } from '../audio/synth';
import { CINE, type CineEvents } from './index';

const SR = 48000;

async function stem(seconds: number, fn: (b: SoundBank) => void) {
  const c = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const b = createSoundBank(c);
  fn(b);
  return c.startRendering();
}

/**
 * Offline soundtrack for the intro, scheduled on the cinematic's event timeline (video seconds).
 * Slowed layers are the game's own sounds played back at reduced rate (deeper, longer).
 * Returns a 48 kHz stereo 16-bit WAV (base64), peak-normalized to about -1 dBTP.
 */
export async function renderSoundtrack(ev: CineEvents, duration: number) {
  const len = Math.ceil(duration * SR);
  const ctx = new OfflineAudioContext(2, len, SR);
  const gunshot = await stem(1.6, (b) => b.gunshot());
  const shatter = await stem(3, (b) => b.shatter(ev.type || 'soda'));
  const splash = await stem(1.6, (b) => b.splash(Math.max(0.3, ev.fill)));
  const tinkles: AudioBuffer[] = [];
  for (let i = 0; i < 6; i++) tinkles.push(await stem(0.9, (b) => b.tinkle(0.006 + i * 0.006, 3 + i * 0.4, 0, 5, 'wood')));
  const dirt = await stem(0.6, (b) => b.tinkle(0.02, 4, 0, 5, 'dirt'));
  const drip = await stem(0.3, (b) => b.drip(0));

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  const rev = ctx.createConvolver();
  rev.buffer = bakeYardIR(ctx);
  const revBig = ctx.createConvolver();
  revBig.buffer = longIR(ctx, 2.4);
  rev.connect(master);
  const revBigOut = ctx.createGain();
  revBigOut.gain.value = 0.5;
  revBig.connect(revBigOut).connect(master);
  const noise = bakeNoise(ctx, 6);

  const out = (node: AudioNode, pan: number, wet = 0, big = 0) => {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    node.connect(p).connect(master);
    if (wet) {
      const g = ctx.createGain();
      g.gain.value = wet;
      p.connect(g).connect(rev);
    }
    if (big) {
      const g = ctx.createGain();
      g.gain.value = big;
      p.connect(g).connect(revBig);
    }
  };
  const play = (buf: AudioBuffer, at: number, rate: number, gain: number, pan = 0, wet = 0, big = 0, lp = 0) => {
    if (at >= duration) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let n: AudioNode = s.connect(g);
    if (lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      n = n.connect(f);
    }
    out(n, pan, wet, big);
    s.start(Math.max(0, at));
  };
  const noiseSrc = (at: number, end: number, filters: [BiquadFilterType, number, number][]) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    let n: AudioNode = s;
    const fs: BiquadFilterNode[] = [];
    for (const [type, f, q] of filters) {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      n = n.connect(b);
      fs.push(b);
    }
    const g = ctx.createGain();
    g.gain.value = 0;
    n.connect(g);
    s.start(Math.max(0, at), (at * 0.37) % 5);
    s.stop(Math.min(duration, end));
    return { g, fs };
  };
  const tone = (at: number, type: OscillatorType, f0: number, f1: number, sweep: number, peak: number, attack: number, tau: number, pan = 0, wet = 0, big = 0) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f1, at + sweep);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.setTargetAtTime(0, at + attack, tau);
    o.connect(g);
    out(g, pan, wet, big);
    o.start(at);
    o.stop(Math.min(duration, at + attack + tau * 8));
  };

  const shot = ev.shot;
  const hit = ev.impact;
  const ret = hit + CINE.hold;

  // ambient wind bed, ducked and darkened in the slow-mo stretch
  {
    const w = noiseSrc(0, duration, [['lowpass', 420, 0.6], ['highpass', 60, 0.7]]);
    out(w.g, 0, 0.3);
    const g = w.g.gain;
    g.setValueAtTime(0, 0);
    g.linearRampToValueAtTime(0.22, 0.6);
    g.setTargetAtTime(0.12, shot, 0.15);
    g.setTargetAtTime(0.2, ret + 0.4, 0.5);
    g.setTargetAtTime(0, duration - 0.45, 0.12);
    w.fs[0].frequency.setValueAtTime(420, 0);
    w.fs[0].frequency.setTargetAtTime(240, shot, 0.2);
    w.fs[0].frequency.setTargetAtTime(420, ret + 0.3, 0.5);
    // drone: a soft gust as the camera glides in
    const gust = noiseSrc(0, CINE.cut + 0.2, [['bandpass', 700, 0.8]]);
    out(gust.g, -0.2, 0.2);
    gust.g.gain.setValueAtTime(0, 0);
    gust.g.gain.linearRampToValueAtTime(0.035, 1.4);
    gust.g.gain.linearRampToValueAtTime(0, CINE.cut + 0.15);
    gust.fs[0].frequency.setValueAtTime(500, 0);
    gust.fs[0].frequency.exponentialRampToValueAtTime(1100, CINE.cut);
  }
  // birds
  const bird = (at: number, f: number, pan: number, n: number) => {
    for (let i = 0; i < n; i++) tone(at + i * 0.11, 'sine', f, f * 1.3, 0.05, 0.022, 0.008, 0.022, pan, 0.6);
  };
  bird(0.55, 3600, -0.6, 3);
  bird(1.75, 3100, 0.5, 2);
  bird(duration - 1.3, 3900, 0.65, 3);

  // gunshot: the real report, then its slowed shadow and a sub drop as time stretches
  play(gunshot, shot, 1, 0.95, 0.05, 0.3);
  play(gunshot, shot + 0.01, 0.3, 0.55, 0, 0.2, 0.5, 2600);
  tone(shot + 0.01, 'sine', 68, 32, 0.9, 0.42, 0.012, 0.55, 0, 0, 0.3);

  // bullet whiz: band-passed air rush + faint spinning whistle, falling in pitch as it pulls away
  {
    const t0 = shot + 0.03;
    const r = noiseSrc(t0, hit + 0.05, [['bandpass', 2400, 2.2], ['lowpass', 5000, 0.6]]);
    out(r.g, 0.1, 0.15, 0.25);
    const g = r.g.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(0.32, t0 + 0.12);
    g.linearRampToValueAtTime(0.22, hit - 0.35);
    g.linearRampToValueAtTime(0.4, hit - 0.06);
    g.linearRampToValueAtTime(0, hit + 0.02);
    r.fs[0].frequency.setValueAtTime(2400, t0);
    r.fs[0].frequency.exponentialRampToValueAtTime(1500, hit - 0.35);
    r.fs[0].frequency.exponentialRampToValueAtTime(700, hit);
    const low = noiseSrc(t0, hit + 0.05, [['lowpass', 380, 0.7]]);
    out(low.g, 0, 0, 0.2);
    low.g.gain.setValueAtTime(0, t0);
    low.g.gain.linearRampToValueAtTime(0.35, t0 + 0.3);
    low.g.gain.linearRampToValueAtTime(0.5, hit - 0.05);
    low.g.gain.linearRampToValueAtTime(0, hit + 0.03);
    // whistle with a spin flutter
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1250, t0);
    o.frequency.exponentialRampToValueAtTime(620, hit);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.03, t0 + 0.2);
    og.gain.linearRampToValueAtTime(0.045, hit - 0.1);
    og.gain.linearRampToValueAtTime(0, hit + 0.01);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 23;
    const lg = ctx.createGain();
    lg.gain.value = 0.018;
    lfo.connect(lg).connect(og.gain);
    o.connect(og);
    out(og, 0.1, 0.2);
    o.start(t0);
    lfo.start(t0);
    o.stop(hit + 0.05);
    lfo.stop(hit + 0.05);
    // the swell that sucks in right before the hit
    const sw = noiseSrc(hit - 0.7, hit + 0.02, [['lowpass', 900, 0.7]]);
    out(sw.g, 0, 0, 0.4);
    sw.g.gain.setValueAtTime(0.0001, hit - 0.7);
    sw.g.gain.exponentialRampToValueAtTime(0.3, hit - 0.01);
    sw.g.gain.linearRampToValueAtTime(0, hit + 0.015);
  }

  // impact: real-speed crack transient, then the slowed, deeper, longer shatter
  const pan = ev.pan * 0.6;
  play(shatter, hit, 1, 0.75, pan, 0.25);
  play(shatter, hit + 0.005, 0.45, 0.9, pan, 0.3, 0.6);
  play(shatter, hit + 0.03, 0.62, 0.45, -pan, 0.2, 0.5);
  // bright glass partials ringing in the stretch
  for (let i = 0; i < 11; i++) {
    const f = 2600 + ((i * 1370) % 5200) + i * 37;
    tone(hit + 0.01 + i * 0.012, 'sine', f, f * 0.985, 2.5, 0.012 + 0.012 * ((i * 7) % 3) / 2, 0.004, 0.5 + ((i * 3) % 5) * 0.22, ((i % 5) - 2) * 0.3, 0.4, 0.5);
  }
  // low cinematic boom (subtle)
  tone(hit, 'sine', 55, 28, 1.4, 0.55, 0.02, 0.85, 0, 0, 0.3);
  {
    const b = noiseSrc(hit, hit + 4, [['lowpass', 150, 0.7]]);
    out(b.g, 0, 0, 0.3);
    b.g.gain.setValueAtTime(0, hit);
    b.g.gain.linearRampToValueAtTime(0.45, hit + 0.03);
    b.g.gain.setTargetAtTime(0, hit + 0.03, 0.55);
  }
  // liquid burst, stretched
  if (ev.fill > 0.02) {
    play(splash, hit + 0.02, 0.5, 0.8, pan, 0.3, 0.4);
    play(splash, ret + 0.15, 0.9, 0.35, pan, 0.3);
  }
  // shards landing (recorded), pitched by the time scale at that moment
  let last = -1;
  let n = 0;
  for (const s of ev.shards) {
    if (s.t - last < 0.012 || n > 80) continue;
    last = s.t;
    n++;
    const rate = (0.55 + 0.45 * Math.min(1, s.scale)) * (0.9 + ((n * 13) % 7) * 0.035);
    const loud = Math.min(1, s.speed / 3) * Math.min(1, 0.4 + s.size * 20);
    const buf = s.size > 0.03 ? tinkles[5] : tinkles[n % 5];
    play(buf, s.t, rate, 0.8 * loud + 0.12, s.pan, 0.25, s.scale < 0.5 ? 0.4 : 0.1);
    if (n % 6 === 0) play(dirt, s.t + 0.01, rate, 0.4 * loud, s.pan, 0.1);
  }
  last = -1;
  n = 0;
  for (const d of ev.drips) {
    if (d.t - last < 0.03 || n > 50) continue;
    last = d.t;
    n++;
    play(drip, d.t, 0.85 + (n % 5) * 0.06, 0.5, d.pan, 0.2);
  }

  const buf = await ctx.startRendering();
  // fade the very end, then normalize to about -1 dBTP (sample peak at -1.6 dBFS, 4x inter-sample check)
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const fade = Math.floor(0.25 * SR);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    L[len - 1 - i] *= k;
    R[len - 1 - i] *= k;
  }
  let peak = 1e-9;
  for (const d of [L, R]) {
    for (let i = 1; i < d.length - 2; i++) {
      const a = d[i - 1], b = d[i], c = d[i + 1], e = d[i + 2];
      peak = Math.max(peak, Math.abs(b));
      for (const x of [0.25, 0.5, 0.75]) {
        // Catmull-Rom estimate of the inter-sample value
        const v = b + 0.5 * x * (c - a + x * (2 * a - 5 * b + 4 * c - e + x * (3 * (b - c) + e - a)));
        peak = Math.max(peak, Math.abs(v));
      }
    }
  }
  const gain = Math.pow(10, -1.6 / 20) / peak;
  for (const d of [L, R]) for (let i = 0; i < d.length; i++) d[i] *= gain;
  return { wav: wavBase64(buf), peakBefore: peak, gain };
}

/** Long, dark, smooth tail for the slow-mo bloom (synthetic). */
function longIR(ctx: BaseAudioContext, seconds: number) {
  const len = Math.ceil(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      lp += (Math.random() * 2 - 1 - lp) * (0.35 - 0.3 * (t / seconds));
      d[i] = lp * Math.exp(-t / 0.55) * Math.min(1, t / 0.02) * 0.35;
    }
  }
  return buf;
}
