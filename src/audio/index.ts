import { Vector3 } from 'three';
import type { World } from '../core/world';
import { createSoundBank, type SoundBank } from './bank';
import { wavBase64 } from './synth';

/**
 * Live audio: one AudioContext, created on the first user gesture. All sounds are synthesized.
 * Calls made before the unlock are silently dropped.
 */
export function createAudio(world: World, getSlow: () => number) {
  let bank: SoundBank | null = null;
  let ambient = false;
  const tmp = new Vector3();

  const unlock = () => {
    if (!bank) {
      try {
        bank = createSoundBank(new AudioContext({ latencyHint: 'interactive' }));
        bank.setAmbient(ambient);
      } catch (e) {
        console.warn('audio unavailable', e);
        return;
      }
    }
    const ctx = bank.ctx as AudioContext;
    if (ctx.state === 'suspended') void ctx.resume();
  };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });

  let lastSlow = -1;
  world.onRealUpdate(() => {
    const s = getSlow();
    if (bank && Math.abs(s - lastSlow) > 0.002) {
      lastSlow = s;
      bank.setSlow(s);
    }
  });

  /** Stereo pan and distance of a world point relative to the camera. */
  const place = (p: Vector3 | null | undefined) => {
    if (!p) return { pan: 0, dist: 6 };
    tmp.copy(p);
    world.camera.worldToLocal(tmp);
    const dist = tmp.length();
    return { pan: Math.max(-0.8, Math.min(0.8, (tmp.x / Math.max(0.5, -tmp.z)) * 2.2)), dist };
  };

  return {
    unlock,
    get bank() {
      return bank;
    },
    gunshot: () => bank?.gunshot(),
    shatter(type: string, p?: Vector3) {
      if (!bank) return;
      const { pan, dist } = place(p);
      bank.shatter(type, pan, dist);
      bank.slowmoIn();
    },
    tinkle(p: Vector3, speed: number, size: number) {
      if (!bank) return;
      const { pan, dist } = place(p);
      bank.tinkle(size, speed, pan, dist);
    },
    splash(fill: number, p?: Vector3) {
      bank?.splash(fill, place(p).pan);
    },
    miss(p: Vector3 | null, isWood: boolean) {
      if (!bank) return;
      const { pan } = place(p);
      if (isWood) bank.woodThud(pan);
      else bank.dirtPuff(pan);
    },
    setVolume: (v: number) => bank?.setVolume(v),
    setAmbient(on: boolean) {
      ambient = on;
      bank?.setAmbient(on);
    },
    /** Dev: render one sound offline and return a base64 WAV. */
    async renderWav(name: 'gunshot' | 'shatter' | 'tinkles' | 'splash' | 'wood' | 'dirt' | 'sequence', type = 'beer', seconds = 2) {
      const ctx = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
      const b = createSoundBank(ctx);
      const used = new Set<number>();
      const at = (t: number, fn: () => void) => {
        let q = Math.ceil((t * 48000) / 128);
        while (used.has(q)) q++;
        used.add(q);
        void ctx.suspend((q * 128) / 48000).then(() => {
          fn();
          void ctx.resume();
        });
      };
      if (name === 'gunshot') b.gunshot();
      else if (name === 'shatter') (b.shatter(type), b.slowmoIn());
      else if (name === 'splash') b.splash(0.8);
      else if (name === 'wood') b.woodThud();
      else if (name === 'dirt') b.dirtPuff();
      else if (name === 'tinkles') for (let i = 0; i < 30; i++) at(0.02 + i * 0.045 + Math.random() * 0.03, () => b.tinkle(0.004 + Math.random() * 0.03, 1 + Math.random() * 4, Math.random() * 1.4 - 0.7));
      else {
        b.gunshot();
        at(0.03, () => (b.shatter(type), b.slowmoIn(), b.splash(0.7), b.setSlow(1)));
        for (let i = 0; i < 26; i++) at(0.35 + i * 0.05 + Math.random() * 0.03, () => b.tinkle(0.004 + Math.random() * 0.03, 1 + Math.random() * 4, Math.random() * 1.4 - 0.7));
        at(1.2, () => b.setSlow(0.3));
        at(1.5, () => b.setSlow(0));
      }
      const buf = await ctx.startRendering();
      let peak = 0;
      let sum = 0;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          peak = Math.max(peak, Math.abs(d[i]));
          sum += d[i] * d[i];
        }
      }
      return { wav: wavBase64(buf), peak, rms: Math.sqrt(sum / (buf.length * 2)) };
    },
  };
}

export type GameAudio = ReturnType<typeof createAudio>;
