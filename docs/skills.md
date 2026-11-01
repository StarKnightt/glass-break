# Installed skills mapped to game systems

Root: `C:\Users\prase\.agents\skills\<name>\SKILL.md` (canonical global install; mirrors exist in `C:\Users\prase\.claude\skills` and some in `C:\Users\prase\.cursor\skills`).
Read a skill's SKILL.md before working on its system. Sources: cloudai-x/threejs-skills, dgreenheck/webgpu-claude-skill, majidmanzarpour/threejs-game-skills (all installed/refreshed), plus the extras added this stage: `threejs-physics` (cesartevisual), `particle-system` (iart-ai), `physics-tuning` (gamedev-skills).

| System | Primary skills | Secondary |
|---|---|---|
| Project setup / architecture | `threejs-dev-setup`, `threejs-game-director`, `threejs-gameplay-systems` | `threejs-game`, `three-best-practices`, `threejs-fundamentals`, `threejs-scene-setup` |
| Scene, lighting, golden hour | `threejs-lighting`, `threejs-materials-lighting`, `threejs-exposure-color-grading`, `threejs-shadow-systems` | `threejs-lights`, `threejs-scenes`, `threejs-atmosphere-aerial-perspective`, `threejs-aaa-graphics-builder` |
| Environment / HDRI / textures | `threejs-loaders`, `threejs-textures`, `polyhaven-studio-setup` (HDRI sourcing ideas) | `threejs-procedural-materials` (weathered wood/dirt), `threejs-procedural-vegetation` (dry grass) |
| Glass material, refraction, liquid look | `threejs-materials`, `threejs-shaders`, `threejs-water-optics` | `shader-dev`, `threejs-node-tsl`, `webgpu-threejs-tsl` (only if a WebGPU path is chosen) |
| Bottle geometry, shards geometry | `threejs-geometry`, `threejs-geometries` | `threejs-objects` (InstancedMesh/BatchedMesh) |
| Shooting / input / raycast | `fps-shooter`, `threejs-interaction`, `threejs-controls` | `threejs-camera` |
| Fracture | (no dedicated skill exists; see research.md §4) `threejs-geometry`, `threejs-procedural-vfx` | `threejs-shaders` (crack shader) |
| Shard physics | `threejs-physics`, `physics-tuning` | `r3f-physics` (Rapier patterns, if Rapier is adopted) |
| Liquid splash, dust, glitter particles | `particle-system`, `threejs-procedural-vfx` | `threejs-precipitation-surfaces` (wet decals/splashes), `threejs-temporal-surfaces` |
| Game feel, slow-mo, camera punch | `game-feel`, `threejs-camera-direction` | `threejs-procedural-animation`, `threejs-animation` |
| Postprocessing (bloom, AA, CA, vignette) | `threejs-postprocessing`, `threejs-bloom` | `threejs-screen-space-ambient-occlusion` (only if budget allows) |
| Audio (Web Audio synthesis) | `game-audio`, `threejs-audio` | `threejs-audio-generator` (uses ElevenLabs, so **not** used: synth only) |
| UI (score + reset) | `threejs-game-ui-designer` | `minimalist-ui` |
| Perf / debugging | `threejs-debug-profiler`, `three-best-practices` | `threejs-renderers`, `web-perf` |
| QA / visual validation (critics) | `threejs-visual-validation`, `threejs-qa-release` | `playwright-best-practices` (screenshot capture) |

Note: `npx skills add -g` prints "PromptScript does not support global skill installation" for one agent target. That's harmless; the other targets installed fine.
