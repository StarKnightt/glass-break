import { HalfFloatType, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { GradeEffect } from './gradeEffect';
import { installPerf } from '../core/perf';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { Vector2 } from 'three';

export function createPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomEffect({
    intensity: 0.4,
    luminanceThreshold: 1.0,
    luminanceSmoothing: 0.3,
    mipmapBlur: true,
    radius: 0.8,
  });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.45 });
  const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.ADD });
  noise.blendMode.opacity.value = 0.035;
  const ca = new ChromaticAberrationEffect({ offset: new Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.35 });

  composer.addPass(new EffectPass(camera, bloom, toneMapping, grade, vignette));
  composer.addPass(new EffectPass(camera, ca, noise));
  composer.addPass(new EffectPass(camera, new SMAAEffect()));

  const perf = installPerf(renderer, scene, camera, composer);

  return { composer, perf, bloom, toneMapping, grade, vignette, noise, ca };
}
