# Critique: system 5 (slow-mo, camera punch, audio, liquid splash). Verdict: FAIL

Evidence: the builder frames in `shots/system5/` (b1/b4/b6 at 60, 200, 450 and 800 ms, plus dbg-drops), an analysis of the WAVs in `shots/system5/audio/` (script: `C:\tmp\shot\an5.py`; levels in dBFS), and the source files `slowmo.ts`, `post.ts`, `bank.ts`, `synth.ts`, `liquid/index.ts` and `wire.ts`. I made no extra captures because of the time limit.

1. **The liquid looks like a flat horizontal starburst of glowing needles.** b6-450 shows a white and yellow radial fan; b4-450 shows brown hair-like streaks. There are four causes:
   (a) The streak length is `aPos.w + speed*aVel.w`, computed from world speed and ignoring the time scale. At 0.2x speed, streaks are 5x too long: a streak drop at 8 m/s with w=0.05 is 40 cm long. Fix: pass a `uTimeScale` uniform and use `len = size + sp * uTimeScale * (1/60)`. In slow-mo, droplets should read as round beads (see the slowmo_* refs).
   (b) `radial` has y=0, `out` reaches 3.2 m/s and vertical speed is only 0.4 to 2.0 m/s, so the spray is a disc. Fix: use a random unit radial with y in ±0.5, set `out = 0.3..1.2` m/s, and send about 70% of the mass into an exit cone along `dir` (half-angle 35°, 1.5 to 3.5 m/s). Add a backsplash cone toward the camera from the entry point (15% of drops, 0.5 to 1.5 m/s).
   (c) The glow is too strong: `vGlow*(0.6+1.6*rim)` plus 0.95-white foam blows out to white. Fix: glow gain 0.25, rim factor 0.5, foam colour 0.75 with alpha 0.5, and scale the liquid colour by about 0.6. Real beer and soda spray reads dark amber or brown with small highlights, not glowing.
   (d) There are no sheets or ligaments, and nothing holds the bottle's shape. Fix: for the first 60 ms of game time, multiply drop velocity by 0.15 so the cloud keeps the bottle silhouette (cola ref). Then release it with 300 to 600 mist drops at 0.8 to 2 mm, and 20 to 40 elongated ligaments at 6 to 12 mm with a fixed (not velocity-based) stretch that break into 3 or 4 child drops at about 120 ms of game time.
2. **Gunshot.** It has no crack and is too quiet. The envelope is a 90 ms plateau at -12 to -15 dB, the peak arrives at 58 ms (from the thump and body layers), and the crest is weak. The bus compressor (threshold -16, ratio 4, attack 2 ms) squashes the transient.
   - Fix the layers: transient peak 1.0*G → 3.0*G with tau 0.011 → 0.004; body tau 0.035 → 0.018; thump gain 0.75 → 0.3 with tau 0.045 → 0.025.
   - Fix the compressor: threshold -10, attack 6 ms.
   - Target: a peak at 1 to 3 ms that falls 25 dB by 20 ms. For the airgun, add a 1.2 to 2.5 kHz pneumatic "thwack" partial (tau 6 ms).
3. **Mix balance is inverted.** In sequence-soda, the gunshot peaks at -15 dB while the glass body peaks at -6 dB. At the shooter's ear the gun should be 6 to 10 dB above the glass 6 m away.
   - Fix: debris buffer gain 0.85 → 0.45 and normalise the baked buffer to 0.6.
   - Targets after fix 2: gun about -3 dB, glass crack -8 dB, debris -14 dB, splash -18 dB.
4. **The shatter has no sharp onset.** The crack starts at -26 dB and the peak arrives 86 ms later (beer) or 71 ms later (whiskey), so it sounds like a swell. A real break peaks within 5 ms.
   - Fix the crack: noise peak 1.0 → 2.5 with tau 0.0045 → 0.008, plus a 3 to 5 kHz sine "tick" mode (tau 5 ms).
   - Start the granular buffer 10 ms later with a 15 ms fade-in.
   - Change the grain density exponent from `pow(u,1.9)` to `pow(u,2.6)` so the burst front-loads into the first 60 ms.
5. **The shatter tail turns into low rumble.** The spectral centroid drops to 0.3 to 0.5 kHz after 0.8 s, and the tail never falls below -40 dB within 1.5 s. The cause is `slowmoIn()`: a 72→30 Hz sine at 0.32 with tau 0.35 s (about 2.4 s long), plus reverb boosted to 0.42. This cinematic "bwomm" plays on every break and is the main source of repetition fatigue.
   - Fix: gain 0.12, tau 0.15, play it only on the first break of a chain, and cap the reverb at 0.3.
6. **The slow-mo audio treatment muffles the glass.** At full slow-mo the world bus lowpasses to 2.5 kHz, but the tinkles centre at 7 to 9 kHz. That removes the payoff exactly while slow-mo is showing the debris.
   - Fix: lowpass `20000→7000` (not 2500); pitch `1-0.18a` (not 0.28); keep the stretch on the splash only.
   - The world bus needs gentle pitch and air, not underwater filtering.
7. **Tinkles are bell-like and do not depend on the surface.** The centroid sits at 7 to 10 kHz throughout, with bar modes ringing for 25 to 90 ms. On dirt, real landings are dull ticks.
   - Pass the surface from `onShardImpact`.
   - Dirt: tau ×0.15, lowpass 3.5 kHz, plus a 250 Hz noise thud (8 ms), and a level ×0.5.
   - Wood: tau ×0.5, keep the brightness.
   - Make sure 3 to 5 large shards produce a distinct heavier clack (playback rate 0.6).
8. **Repeated breaks hit the camera and post effects too hard.** Each break costs about 1.22 s of real time (extendable to 1.5 s), and every break also re-fires the FOV punch, CA ×2.6, -14% saturation and +0.16 vignette. Six bottles add up to about 7 s of slow-mo, which gets tedious by the third. The CA fringing is visible on the bottles in b1-200, and the desaturation greys out the golden-hour grade.
   - Fix timing: for the k-th break within 3 s, scale the hold by 0.6^k and use `slowScale` 0.2→0.35; only skip the 50 ms hit-stop when the previous break was under 0.4 s ago.
   - Fix post: CA ×1.3, desaturation 6%, vignette +0.08.
   - Fix the camera: FOV punch 1.6° → 2.4° with a 60 ms attack, decaying to 0.8° for the hold. Set `pushIn` to 0, because a 4.5 cm push at 6 m is invisible but shifts aim parallax for follow-up shots.
9. **Splash and miss sounds are not wet or woody.**
   - Splash peaks at -16 dB, sits under the shatter, and is just bandpassed hiss at 0.8 to 1.5 kHz. Add 12 to 20 Minnaert bubble chirps: sine sweeping up 0.6→2 kHz, tau 15 ms, spread over 0 to 250 ms. Add patter driven by the liquid's `onLand` events instead of 7 random clicks.
   - The wood miss is a 330→160 Hz drum-like thud (centroid 0.1 to 0.2 kHz). Real pellet-into-wood is a "tock": noise bandpass 1.3 kHz → peak ×2, sine 330 → 700→400 Hz, tau 8 ms, low sine gain 0.25 → 0.1.
   - Remove the shatter echo send (0.5 → 0.1). Hill echoes at 0.37 and 0.66 s suit the gun only.
10. **Wet spots and performance.** The wet spot is one alpha-blended disc of 0.04/0.025/0.01 at α 0.45 under the bottle, and none were visible in any frame.
    - Darken multiplicatively (×0.6 albedo plus a spec gloss term), spawn spots where drops land on the rail and dirt (2 to 6 cm), and fade them over 8 to 15 s instead of a short life.
    - Performance is fine at under 300 instanced sprites. Once fix 1a lands, the 40 cm streak overdraw goes away. Keep under 600 drops. At startup, the main thread bakes 9 shatter buffers and 18 tinkles synchronously; measure this and move it to an idle callback if it exceeds 30 ms.

Fracture-side note (not this system): the first shatter arrived about 430 ms after the shot. A pellet covers 6 m in about 40 ms, so onShatter should fire within 1 to 2 frames of the hit. Until it does, hit-stop and audio sync are off by more than 0.4 s.

Paths: this file is `F:\glass-break\docs\critique-system5.md`; the analysis script is `C:\tmp\shot\an5.py`; the frames are in `F:\glass-break\shots\system5\`.
