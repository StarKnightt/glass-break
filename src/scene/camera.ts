import { Euler, PerspectiveCamera, Vector3 } from 'three';

const VIEW = new URLSearchParams(location.search).get('view');
/** `?view=rail` is a dev close-up of the top rail for visual checks. */
export const EYE = VIEW === 'rail' ? new Vector3(-0.5, 1.62, 1.9) : new Vector3(-1.35, 1.63, 6.6);
export const LOOK_AT = VIEW === 'rail' ? new Vector3(0.5, 1.15, 0) : new Vector3(0.45, 1.1, 0);

/**
 * First-person camera rig. `yaw`/`pitch` are the aim offsets (later driven by the shooting
 * system); `sway` adds a slow handheld drift on top. Additive offsets (`kick`) are for recoil.
 */
export function createCameraRig(aspect: number) {
  const camera = new PerspectiveCamera(42, aspect, 0.05, 600);
  camera.position.copy(EYE);
  camera.lookAt(LOOK_AT);
  const base = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');

  const rig = {
    camera,
    yaw: 0,
    pitch: 0,
    kick: { yaw: 0, pitch: 0, roll: 0 },
    swayAmount: 1,
    baseFov: 42,
    /** Slight handheld roll (rad). */
    roll: 0.007,
    update(t: number) {
      // sum of incommensurate sines ~ breathing + hand tremor (radians)
      const a = rig.swayAmount;
      const sy = (Math.sin(t * 0.31) * 0.0016 + Math.sin(t * 0.73 + 1.3) * 0.0008 + Math.sin(t * 1.9) * 0.00022) * a;
      const sp = (Math.sin(t * 0.47 + 0.4) * 0.0012 + Math.sin(t * 0.21) * 0.001 + Math.sin(t * 2.3 + 2.0) * 0.0002) * a;
      const sr = Math.sin(t * 0.17 + 0.8) * 0.0012 * a;
      camera.rotation.set(
        base.x + rig.pitch + sp + rig.kick.pitch,
        base.y + rig.yaw + sy + rig.kick.yaw,
        rig.roll + sr + rig.kick.roll,
        'YXZ',
      );
      camera.position.set(EYE.x + Math.sin(t * 0.23) * 0.006 * a, EYE.y + Math.sin(t * 0.41) * 0.004 * a, EYE.z);
    },
  };
  return rig;
}

export type CameraRig = ReturnType<typeof createCameraRig>;
