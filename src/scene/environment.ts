import {
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FloatType,
  FogExp2,
  HemisphereLight,
  Matrix3,
  Matrix4,
  Scene,
  Vector3,
  type DataTexture,
} from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { loadingManager } from './textures';

/** Sun centroid in rolling_hills_2k.hdr, measured offline (equirect u, elevation in degrees). */
const HDR_SUN_U = 0.5997;
const HDR_SUN_ELEV_DEG = 9.16;
/** Y rotation applied to background + environment so the sun sits front-left of the fence. */
export const ENV_ROT_Y = (141 * Math.PI) / 180;
const HDR_CLAMP = 40;

export const SUN_INTENSITY = 5.5;
export const SUN_COLOR = new Color('#ffb36e');
export const FOG_COLOR = new Color('#b9a58c');

export interface EnvResult {
  sun: DirectionalLight;
  sunDir: Vector3;
  hdr: DataTexture;
  /** Rotation that maps a world view direction to the HDR texture's sample direction. */
  bgSampleRot: Matrix3;
}

/**
 * The raw sun disc is ~40,000x brighter than the sky. The directional light already carries
 * the sun's energy, so clamp it: otherwise bloom turns the whole frame into veiling glare
 * and the PMREM env double-counts the sun.
 */
function clampRadiance(tex: DataTexture, max: number) {
  const d = tex.image.data as Float32Array;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    if (m > max) {
      const k = max / m;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
  }
  tex.needsUpdate = true;
}

export async function setupEnvironment(scene: Scene): Promise<EnvResult> {
  const hdr = (await new HDRLoader(loadingManager)
    .setDataType(FloatType)
    .loadAsync('/hdri/rolling_hills_2k.hdr')) as DataTexture;
  hdr.mapping = EquirectangularReflectionMapping;
  clampRadiance(hdr, HDR_CLAMP);

  scene.background = hdr;
  scene.environment = hdr;
  scene.backgroundRotation.set(0, ENV_ROT_Y, 0);
  scene.environmentRotation.set(0, ENV_ROT_Y, 0);
  scene.backgroundIntensity = 0.8;
  scene.environmentIntensity = 0.42;
  scene.fog = new FogExp2(FOG_COLOR.getHex(), 0.0018);

  const bgSampleRot = new Matrix3().setFromMatrix4(new Matrix4().makeRotationY(ENV_ROT_Y)).transpose();

  // Direction toward the HDRI sun after the background rotation.
  const phi = (HDR_SUN_U - 0.5) * Math.PI * 2;
  const az = new Vector3(Math.cos(phi), 0, Math.sin(phi)).applyAxisAngle(new Vector3(0, 1, 0), ENV_ROT_Y);
  const e = (HDR_SUN_ELEV_DEG * Math.PI) / 180;
  const sunDir = new Vector3(az.x * Math.cos(e), Math.sin(e), az.z * Math.cos(e)).normalize();

  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(sunDir).multiplyScalar(30);
  sun.target.position.set(0, 0.6, 1.5);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -10;
  sc.right = 10;
  sc.top = 3.2;
  sc.bottom = -3.2;
  sc.near = 10;
  sc.far = 55;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  const hemi = new HemisphereLight('#8fa6c8', '#3a3530', 0.2);
  scene.add(hemi);

  return { sun, sunDir, hdr, bgSampleRot };
}
