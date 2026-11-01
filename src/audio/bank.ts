import { bakeNoise, bakeShatter, bakeTinkle, bakeYardIR, GLASS_PITCH } from './synth';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const MAX_TINKLES = 24;

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
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
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

  const impact = ctx.createGain();
  impact.connect(master);
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
  const shatterBank: Record<string, AudioBuffer[]> = {};
  for (const [k, p] of Object.entries(GLASS_PITCH)) shatterBank[k] = [0, 1, 2].map(() => bakeShatter(ctx, p));
  const tinkles = Array.from({ length: 18 }, () => bakeTinkle(ctx));
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
      const v = rnd(0.9, 1.08);
      const pan = rnd(-0.06, 0.06);
      // sharp transient (report)
      noiseVoice(t, [['highpass', 1400 * v, 0.7], ['peaking', 3200 * v, 1.2]], 1.0, 0.0006, 0.011, { pan, rev: 0.5, echo: 1.0 });
      // air blast body
      noiseVoice(t, [['bandpass', 900 * v, 0.8]], 0.55, 0.001, 0.035, { pan, rev: 0.6, echo: 0.8 });
      // low thump (chest of the gun)
      toneVoice(t, 'sine', 150 * v, 45, 0.07, 0.75, 0.002, 0.045, { pan, rev: 0.2 });
      // mechanism click + spring twang
      noiseVoice(t - 0.004, [['bandpass', 5200, 4]], 0.18, 0.0003, 0.003, { pan: pan + 0.1 });
      toneVoice(t + 0.002, 'triangle', 420 * v, 380 * v, 0.05, 0.05, 0.001, 0.03, { pan: pan + 0.1 });
      // short outdoor tail
      noiseVoice(t + 0.01, [['lowpass', 1600, 0.5]], 0.12, 0.01, 0.09, { pan, rev: 0.8, echo: 0.4 });
    },
    /** Layered glass break. `distance` (m) only shades level slightly. */
    shatter(type: string, pan = 0, distance = 6) {
      const t = ctx.currentTime + 0.003;
      const p = GLASS_PITCH[type] ?? 1;
      const lvl = Math.min(1.2, 6 / Math.max(3, distance));
      // initial crack: very short bright noise burst + tick (never slowed)
      noiseVoice(t, [['highpass', 2600 * p, 0.7], ['peaking', 6500 * p, 1.5]], 1.0 * lvl, 0.0003, 0.0045, { pan, rev: 0.4, echo: 0.5 });
      noiseVoice(t, [['bandpass', 1800 * p, 1.2]], 0.35 * lvl, 0.0005, 0.012, { pan, rev: 0.3 });
      // low body thump of the bottle letting go
      toneVoice(t, 'sine', 230 * p, 85 * p, 0.06, 0.55 * lvl, 0.0015, 0.035, { pan, rev: 0.3 });
      noiseVoice(t, [['lowpass', 520 * p, 0.7]], 0.4 * lvl, 0.001, 0.03, { pan });
      // ringing partials + granular shatter (debris layer, pitched/filtered by slow-mo)
      const src = ctx.createBufferSource();
      const list = shatterBank[type] ?? shatterBank.beer;
      src.buffer = list[Math.floor(Math.random() * list.length)];
      src.playbackRate.value = rnd(0.95, 1.05) * (0.82 + 0.18 * slowPitch);
      const g = ctx.createGain();
      g.gain.value = 0.85 * lvl;
      src.connect(g);
      route(g, { bus: 'world', pan: pan * 0.6, rev: 0.45, echo: 0.25 });
      src.start(t + 0.002);
    },
    /** Slow-mo onset: a subtle sub "drop" under the break, plus a soft air swell. */
    slowmoIn() {
      const t = ctx.currentTime + 0.01;
      toneVoice(t, 'sine', 72, 30, 0.9, 0.32, 0.02, 0.35, {});
      noiseVoice(t, [['lowpass', 380, 0.6]], 0.07, 0.12, 0.3, { rev: 0.6 });
    },
    /** Shard hitting wood/dirt. size in m, speed in m/s. */
    tinkle(size: number, speed: number, pan = 0, distance = 6) {
      if (tinkleVoices >= MAX_TINKLES) return;
      const loud = Math.min(1, speed / 4) * Math.min(1, 0.35 + size * 18) * Math.min(1, 6 / Math.max(3, distance));
      if (loud < 0.03) return;
      tinkleVoices++;
      const src = ctx.createBufferSource();
      src.buffer = tinkles[Math.floor(Math.random() * tinkles.length)];
      // smaller pieces ring higher
      const sizeK = Math.min(1.6, Math.max(0.6, 0.02 / Math.max(0.004, size)));
      src.playbackRate.value = sizeK * rnd(0.85, 1.2) * slowPitch;
      const g = ctx.createGain();
      g.gain.value = 0.32 * loud;
      src.connect(g);
      route(g, { bus: 'world', pan, rev: 0.35 + slowAmt * 0.3 });
      src.onended = () => {
        tinkleVoices--;
        g.disconnect();
      };
      src.start(ctx.currentTime + Math.random() * 0.004);
    },
    /** Liquid burst; fill 0..1. */
    splash(fill: number, pan = 0) {
      const t = ctx.currentTime + 0.012;
      const stretch = 1 + slowAmt * 1.2;
      const a = 0.35 + 0.5 * fill;
      noiseVoice(t, [['bandpass', 950, 0.7], ['lowpass', 2400, 0.5]], 0.5 * a, 0.004, 0.07 * stretch, { bus: 'world', pan, rev: 0.4 }, slowPitch);
      noiseVoice(t, [['lowpass', 380, 0.8]], 0.4 * a, 0.006, 0.05 * stretch, { bus: 'world', pan });
      for (let i = 0; i < 7; i++) {
        const dt = (0.05 + Math.pow(Math.random(), 1.4) * 0.35) * stretch;
        noiseVoice(t + dt, [['bandpass', rnd(600, 1700) * slowPitch, 2.2]], rnd(0.08, 0.22) * a, 0.002, rnd(0.008, 0.02), { bus: 'world', pan: pan + rnd(-0.4, 0.4), rev: 0.3 });
      }
    },
    /** Pellet into wood: hollow knock. */
    woodThud(pan = 0) {
      const t = ctx.currentTime + 0.004;
      const v = rnd(0.92, 1.08);
      toneVoice(t, 'sine', 330 * v, 160 * v, 0.04, 0.45, 0.001, 0.025, { pan, rev: 0.4, echo: 0.3 });
      noiseVoice(t, [['bandpass', 1300 * v, 2.5]], 0.5, 0.0005, 0.008, { pan, rev: 0.3 });
      toneVoice(t, 'sine', 95, 70, 0.05, 0.25, 0.002, 0.04, { pan });
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
      slowPitch = 1 - 0.28 * a;
      const now = ctx.currentTime;
      slowLP.frequency.setTargetAtTime(20000 * Math.pow(2500 / 20000, a), now, 0.03);
      revOut.gain.setTargetAtTime(0.22 + 0.2 * a, now, 0.05);
    },
    setVolume(v: number) {
      master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
  };

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
