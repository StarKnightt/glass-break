import { bakeNoise, bakeShatter, bakeTinkle, bakeYardIR, GLASS_PITCH } from './synth';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const MAX_TINKLES = 24;
type IdleFn = (f: () => void) => void;
const idle: IdleFn = (globalThis as { requestIdleCallback?: IdleFn }).requestIdleCallback ?? ((f) => setTimeout(f, 30));

export interface VoiceOpts {
  /** 'impact' is never slow-mo filtered; 'world' follows the slow-mo lowpass. */
  bus?: 'impact' | 'world';
  pan?: number;
  rev?: number;
  echo?: number;
}

/** The whole synth graph on any (live or offline) audio context. */
export function createSoundBank(ctx: BaseAudioContext) {
  const out = ctx.createGain();
  out.gain.value = 0.85;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.006;
  comp.release.value = 0.14;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.0005;
  limiter.release.value = 0.06;
  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(comp).connect(limiter).connect(out).connect(ctx.destination);

  // transients skip the bus compressor (parallel path straight into the limiter)
  const impact = ctx.createGain();
  impact.gain.value = 0.6;
  impact.connect(limiter);
  const slowLP = ctx.createBiquadFilter();
  slowLP.type = 'lowpass';
  slowLP.frequency.value = 20000;
  slowLP.Q.value = 0.9;
  const world = ctx.createGain();
  world.connect(slowLP).connect(master);

  const rev = ctx.createConvolver();
  rev.buffer = bakeYardIR(ctx);
  const revIn = ctx.createGain();
  const revOut = ctx.createGain();
  revOut.gain.value = 0.22;
  revIn.connect(rev).connect(revOut).connect(master);

  // slap echoes off the far hills: two distance-delayed, darkened, quiet repeats
  const echoIn = ctx.createBiquadFilter();
  echoIn.type = 'highpass';
  echoIn.frequency.value = 250;
  for (const [delay, cut, g, pan] of [[0.37, 2200, 0.2, -0.35], [0.66, 1300, 0.09, 0.45]] as const) {
    const d = ctx.createDelay(1);
    d.delayTime.value = delay;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cut;
    const gn = ctx.createGain();
    gn.gain.value = g;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    echoIn.connect(d).connect(lp).connect(gn).connect(p).connect(revIn);
    p.connect(master);
  }

  const noise = bakeNoise(ctx, 2);
  // baked lazily (first use) and in idle slices, so startup never blocks
  const shatterBank: Record<string, AudioBuffer[]> = {};
  const shatterBuf = (type: string) => {
    const list = (shatterBank[type] ??= []);
    if (list.length < 3) list.push(bakeShatter(ctx, GLASS_PITCH[type] ?? 1));
    return list[Math.floor(Math.random() * list.length)];
  };
  const woodTinkles: AudioBuffer[] = [];
  const dirtTinkles: AudioBuffer[] = [];
  const tinkleBuf = (dirt: boolean) => {
    const list = dirt ? dirtTinkles : woodTinkles;
    if (list.length < 10) list.push(bakeTinkle(ctx, dirt ? 0.15 : 0.5));
    return list[Math.floor(Math.random() * list.length)];
  };
  let chainAt = -1e9;
  let tinkleVoices = 0;
  /** 1 at normal speed, lower in slow-mo (debris pitched down). */
  let slowPitch = 1;
  let slowAmt = 0;

  function route(node: AudioNode, o: VoiceOpts) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan ?? 0;
    node.connect(p).connect(o.bus === 'world' ? world : impact);
    if (o.rev) {
      const g = ctx.createGain();
      g.gain.value = o.rev;
      p.connect(g).connect(revIn);
    }
    if (o.echo) {
      const g = ctx.createGain();
      g.gain.value = o.echo;
      p.connect(g).connect(echoIn);
    }
  }

  /** Gain envelope: linear attack, exponential (setTarget) decay. Returns the stop time. */
  function env(g: GainNode, t: number, peak: number, attack: number, tau: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, tau);
    return t + attack + tau * 7;
  }

  function noiseVoice(
    t: number,
    filters: [BiquadFilterType, number, number][],
    peak: number,
    attack: number,
    tau: number,
    o: VoiceOpts,
    rate = 1,
  ) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = rate;
    let n: AudioNode = src;
    for (const [type, f, q] of filters) {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      n = n.connect(b);
    }
    const g = ctx.createGain();
    n.connect(g);
    route(g, o);
    const end = env(g, t, peak, attack, tau);
    src.start(t, Math.random() * 1.5);
    src.stop(end);
  }

  function toneVoice(t: number, type: OscillatorType, f0: number, f1: number, sweep: number, peak: number, attack: number, tau: number, o: VoiceOpts) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const g = ctx.createGain();
    osc.connect(g);
    route(g, o);
    const end = env(g, t, peak, attack, tau);
    osc.start(t);
    osc.stop(end);
  }

  const bank = {
    ctx,
    master,
    /** Air rifle: sharp pneumatic crack, low thump, short tail; the hills answer. */
    gunshot() {
      const t = ctx.currentTime + 0.005;
      const v = rnd(0.92, 1.08);
      const pan = rnd(-0.06, 0.06);
      // report: peak within ~1-2 ms, ~-25 dB by 20 ms
      noiseVoice(t, [['highpass', 1500 * v, 0.7], ['peaking', 3400 * v, 1.2]], 6.6, 0.0005, 0.004, { pan, rev: 0.3, echo: 0.2 });
      // pneumatic thwack partial
      toneVoice(t, 'sine', 2100 * v, 1300 * v, 0.012, 0.9, 0.0004, 0.006, { pan, rev: 0.3, echo: 0.2 });
      // air blast body
      noiseVoice(t, [['bandpass', 900 * v, 0.8]], 1.2, 0.0008, 0.018, { pan, rev: 0.5, echo: 0.6 });
      // low thump
      toneVoice(t, 'sine', 150 * v, 50, 0.04, 0.3, 0.0015, 0.025, { pan, rev: 0.2 });
      // mechanism click + spring twang
      noiseVoice(t - 0.004, [['bandpass', 5200, 4]], 0.35, 0.0003, 0.003, { pan: pan + 0.1 });
      toneVoice(t + 0.002, 'triangle', 420 * v, 380 * v, 0.05, 0.08, 0.001, 0.03, { pan: pan + 0.1 });
      // short outdoor tail
      noiseVoice(t + 0.008, [['lowpass', 1600, 0.5]], 0.16, 0.01, 0.07, { pan, rev: 0.8, echo: 0.4 });
    },
    /** Layered glass break. `distance` (m) only shades level slightly. */
    shatter(type: string, pan = 0, distance = 6) {
      const t = ctx.currentTime + 0.003;
      const p = GLASS_PITCH[type] ?? 1;
      const lvl = Math.min(1.2, 6 / Math.max(3, distance));
      // initial crack: bright noise burst + glassy tick, peak within ~1 ms (never slowed)
      noiseVoice(t, [['highpass', 2600 * p, 0.7], ['peaking', 6500 * p, 1.5]], 2.2 * lvl, 0.0003, 0.008, { pan, rev: 0.25, echo: 0.1 });
      toneVoice(t, 'sine', rnd(3000, 5000) * p, rnd(2800, 4600) * p, 0.01, 0.3 * lvl, 0.0003, 0.005, { pan, rev: 0.2 });
      noiseVoice(t, [['bandpass', 1800 * p, 1.2]], 0.35 * lvl, 0.0005, 0.012, { pan, rev: 0.25 });
      // low body thump of the bottle letting go
      toneVoice(t, 'sine', 230 * p, 85 * p, 0.05, 0.35 * lvl, 0.0015, 0.03, { pan, rev: 0.2 });
      noiseVoice(t, [['lowpass', 520 * p, 0.7]], 0.3 * lvl, 0.001, 0.025, { pan });
      // ringing partials + granular shatter (debris layer, gently pitched/filtered by slow-mo)
      const src = ctx.createBufferSource();
      src.buffer = shatterBuf(type);
      src.playbackRate.value = rnd(0.95, 1.05) * (0.9 + 0.1 * slowPitch);
      const g = ctx.createGain();
      g.gain.value = 0.28 * lvl;
      src.connect(g);
      route(g, { bus: 'world', pan: pan * 0.6, rev: 0.35, echo: 0.05 });
      src.start(t + 0.01);
    },
    /** Slow-mo onset: a subtle sub "drop" under the break, plus a soft air swell. */
    slowmoIn() {
      const now = ctx.currentTime;
      const first = now - chainAt > 3;
      chainAt = now;
      if (!first) return; // first break of a chain only
      toneVoice(now + 0.01, 'sine', 70, 40, 0.3, 0.12, 0.015, 0.15, {});
    },
    /** Shard hitting wood/dirt. size in m, speed in m/s. */
    tinkle(size: number, speed: number, pan = 0, distance = 6, surface: 'wood' | 'dirt' = 'wood') {
      if (tinkleVoices >= MAX_TINKLES) return;
      const dirt = surface === 'dirt';
      const big = size > 0.03;
      let loud = Math.min(1, speed / 4) * Math.min(1, 0.35 + size * 18) * Math.min(1, 6 / Math.max(3, distance));
      if (dirt) loud *= 0.5;
      if (loud < 0.03) return;
      tinkleVoices++;
      const t = ctx.currentTime + Math.random() * 0.004;
      const src = ctx.createBufferSource();
      src.buffer = tinkleBuf(dirt);
      const sizeK = big ? 0.6 : Math.min(1.6, Math.max(0.7, 0.02 / Math.max(0.004, size)));
      src.playbackRate.value = sizeK * rnd(0.88, 1.15) * slowPitch;
      const g = ctx.createGain();
      g.gain.value = 0.32 * loud * (big ? 1.3 : 1);
      let n: AudioNode = src.connect(g);
      if (dirt) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3500;
        n = n.connect(lp);
        noiseVoice(t, [['lowpass', 250, 0.8]], 0.6 * loud, 0.001, 0.003, { bus: 'world', pan }); // ~8 ms thud
      } else if (big) {
        noiseVoice(t, [['bandpass', 1400, 2]], 0.35 * loud, 0.0005, 0.006, { bus: 'world', pan, rev: 0.2 }); // heavier clack
      }
      route(n, { bus: 'world', pan, rev: dirt ? 0.12 : 0.3 + slowAmt * 0.1 });
      src.onended = () => {
        tinkleVoices--;
        g.disconnect();
      };
      src.start(t);
    },
    /** One droplet landing (patter). */
    drip(pan = 0) {
      const t = ctx.currentTime + Math.random() * 0.01;
      noiseVoice(t, [['bandpass', rnd(1200, 3000), 2]], rnd(0.06, 0.14), 0.0005, 0.004, { bus: 'world', pan, rev: 0.2 });
      if (Math.random() < 0.4) {
        const f = rnd(900, 1600);
        toneVoice(t, 'sine', f, f * 2.2, 0.02, 0.05, 0.0005, 0.01, { bus: 'world', pan });
      }
    },
    /** Liquid burst; fill 0..1. */
    splash(fill: number, pan = 0) {
      const t = ctx.currentTime + 0.012;
      const stretch = 1 + slowAmt * 1.2;
      const a = (0.35 + 0.5 * fill) * 2.6;
      noiseVoice(t, [['bandpass', 950, 0.7], ['lowpass', 2400, 0.5]], 0.5 * a, 0.004, 0.07 * stretch, { bus: 'world', pan, rev: 0.4 }, slowPitch);
      noiseVoice(t, [['lowpass', 380, 0.8]], 0.4 * a, 0.006, 0.05 * stretch, { bus: 'world', pan });
      // Minnaert bubble chirps (rising sines)
      const nb = 12 + Math.floor(Math.random() * 9);
      for (let i = 0; i < nb; i++) {
        const dt = Math.pow(Math.random(), 1.3) * 0.25 * stretch;
        const f0 = rnd(600, 1100) * slowPitch;
        toneVoice(t + dt, 'sine', f0, f0 * rnd(1.8, 2.6), 0.03, rnd(0.04, 0.1) * a, 0.001, 0.015, { bus: 'world', pan: pan + rnd(-0.4, 0.4), rev: 0.3 });
      }
    },
    /** Pellet into wood: hollow knock. */
    woodThud(pan = 0) {
      const t = ctx.currentTime + 0.004;
      const v = rnd(0.92, 1.08);
      noiseVoice(t, [['bandpass', 1300 * v, 2.5]], 4.0, 0.0004, 0.006, { pan, rev: 0.4, echo: 0.3 });
      toneVoice(t, 'sine', 700 * v, 400 * v, 0.012, 1.4, 0.0005, 0.008, { pan, rev: 0.3 });
      toneVoice(t, 'sine', 180 * v, 140 * v, 0.03, 0.1, 0.001, 0.015, { pan });
    },
    /** Pellet into dirt: dull puff. */
    dirtPuff(pan = 0) {
      const t = ctx.currentTime + 0.004;
      noiseVoice(t, [['lowpass', 700, 0.6]], 0.35, 0.002, 0.045, { pan, rev: 0.2 });
      toneVoice(t, 'sine', 80, 50, 0.05, 0.3, 0.002, 0.03, { pan });
      for (let i = 0; i < 4; i++) noiseVoice(t + rnd(0.01, 0.08), [['bandpass', rnd(1500, 3000), 3]], 0.05, 0.001, 0.006, { pan: pan + rnd(-0.3, 0.3) });
    },
    /** 0..1 slowness: lowpass the world bus toward 2.5 kHz, pitch debris down, open the reverb a bit. */
    setSlow(a: number) {
      slowAmt = a;
      slowPitch = 1 - 0.18 * a;
      const now = ctx.currentTime;
      slowLP.frequency.setTargetAtTime(20000 * Math.pow(7000 / 20000, a), now, 0.03);
      revOut.gain.setTargetAtTime(0.22 + 0.08 * a, now, 0.05);
    },
    setVolume(v: number) {
      master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
  };

  /** Bakes the remaining variants in idle slices (one buffer per slice). */
  if (typeof OfflineAudioContext === 'undefined' || !(ctx instanceof OfflineAudioContext)) {
    const jobs: (() => void)[] = [];
    for (const k of Object.keys(GLASS_PITCH)) for (let i = 0; i < 3; i++) jobs.push(() => void shatterBuf(k));
    for (let i = 0; i < 10; i++) jobs.push(() => (tinkleBuf(true), tinkleBuf(false)));
    const step = () => {
      const j = jobs.shift();
      if (!j) return;
      j();
      idle(step);
    };
    idle(step);
  }

  // ambient bed (off by default): wind + rare distant bird
  let wind: { stop(): void } | null = null;
  let birdTimer = 0;
  function bird() {
    const t = ctx.currentTime + 0.01;
    const n = 2 + Math.floor(Math.random() * 4);
    const f = rnd(2800, 4200);
    const pan = rnd(-0.8, 0.8);
    for (let i = 0; i < n; i++) toneVoice(t + i * rnd(0.09, 0.14), 'sine', f, f * rnd(1.15, 1.4), 0.05, 0.018, 0.008, 0.02, { pan, rev: 0.8 });
  }
  Object.assign(bank, {
    setAmbient(on: boolean) {
      if (on && !wind) {
        const src = ctx.createBufferSource();
        src.buffer = noise;
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 320;
        const g = ctx.createGain();
        g.gain.value = 0.03;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.08;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 0.018;
        lfo.connect(lfoG).connect(g.gain);
        src.connect(lp).connect(g).connect(world);
        src.start();
        lfo.start();
        const tick = () => {
          bird();
          birdTimer = window.setTimeout(tick, rnd(7000, 16000));
        };
        birdTimer = window.setTimeout(tick, rnd(3000, 8000));
        wind = { stop: () => (src.stop(), lfo.stop(), clearTimeout(birdTimer)) };
      } else if (!on && wind) {
        wind.stop();
        wind = null;
      }
    },
  });
  return bank as typeof bank & { setAmbient(on: boolean): void };
}

export type SoundBank = ReturnType<typeof createSoundBank>;
