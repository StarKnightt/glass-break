import {
  LoadingManager,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type WebGLRenderer,
} from 'three';

export const loadingManager = new LoadingManager();
const loader = new TextureLoader(loadingManager);

export interface PbrSet {
  map: Texture;
  normalMap: Texture;
  /** Packed AO (R) / roughness (G) / metalness (B). */
  arm: Texture;
}

export function loadPbr(renderer: WebGLRenderer, name: string, repeat = 1): PbrSet {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const load = (suffix: string, srgb: boolean) => {
    const t = loader.load(`/tex/${name}_${suffix}_2k.jpg`);
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    return t;
  };
  return { map: load('diff', true), normalMap: load('nor_gl', false), arm: load('arm', false) };
}
