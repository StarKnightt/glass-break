import { AdditiveBlending, CanvasTexture, Color, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5); // z: 0 → 1 along the shadow

/**
 * Fake transmitted light on the rail: a tinted sheet filling the bottle's shadow, with a bright
 * focused caustic band (the bottle acts as a cylindrical lens) and wavy filaments, clipped to the
 * rail top. Additive, so it reads as colored light inside the (lightened) glass shadow.
 */
export function createCaustic(tint: Color, radius: number, height: number, sunDir: Vector3, railZ: [number, number]) {
  const flat = new Vector3(-sunDir.x, 0, -sunDir.z).normalize();
  const elev = Math.asin(Math.min(0.99, Math.max(0.05, sunDir.y)));
  const len = Math.min(1.4, height / Math.tan(elev));
  const mat = new ShaderMaterial({
    uniforms: {
      uTint: { value: tint.clone() },
      uStrength: { value: 1 },
      uTime: { value: 0 },
      uRailZ: { value: railZ },
      uFill: { value: 0 },
      uLen: { value: len },
      uR: { value: radius },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vW;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint; uniform float uStrength, uTime, uFill, uLen, uR; uniform vec2 uRailZ;
      varying vec2 vUv; varying vec3 vW;
      void main(){
        float x = vUv.x * 2.0 - 1.0;   // across the shadow, ±1 = bottle radius
        float s = 1.0 - vUv.y;          // 0 at bottle base, 1 at the neck tip of the shadow
        float d = s * uLen / uR;        // distance from the base center in bottle radii
        float w = mix(1.0, 0.36, smoothstep(0.5, 0.72, s));
        float body = smoothstep(w, w * 0.55, abs(x)) * smoothstep(0.9, 1.3, d) * smoothstep(1.0, 0.9, s);
        // the thick base + body act as a cylindrical lens: a bright crescent just outside the
        // footprint, then a focused line down the shadow axis with wavy filaments
        float crescent = exp(-pow((d - 1.25 - 0.25 * x * x) / 0.16, 2.0)) * smoothstep(0.95, 0.3, abs(x));
        float focusLine = exp(-pow(x / 0.09, 2.0)) * smoothstep(1.1, 1.8, d) * smoothstep(0.6, 0.35, s);
        float wav = 0.5 + 0.5 * sin(x * 19.0 + sin(d * 3.1 + uTime * 0.5) * 1.7 + d * 1.3);
        wav = pow(wav, 8.0) * body;
        float liquidBoost = 1.0 + uFill * 1.2;
        vec3 c = uTint * (body * 0.07 + wav * 0.35 + (focusLine * 0.9 + crescent * 1.1) * liquidBoost);
        float clip = smoothstep(uRailZ.x, uRailZ.x + 0.01, vW.z) * smoothstep(uRailZ.y, uRailZ.y - 0.01, vW.z);
        gl_FragColor = vec4(c * uStrength * clip, 1.0);
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geo, mat);
  mesh.scale.set(radius * 2.1, 1, len);
  mesh.lookAt(flat); // object +z → shadow direction
  mesh.rotation.set(0, Math.atan2(flat.x, flat.z), 0);
  mesh.position.y = 0.0015;
  mesh.renderOrder = 2;
  mesh.name = 'caustic';
  return mesh;
}

let aoTex: CanvasTexture | null = null;
/** Soft contact darkening under a bottle base (the grazing sun leaves the rail top shadowless). */
export function createContactShadow(radius: number) {
  if (!aoTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.42, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.3)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    aoTex = new CanvasTexture(c);
  }
  const m = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  );
  m.scale.set(radius * 3.4, 1, radius * 3.4);
  m.position.y = 0.0008;
  m.name = 'contactShadow';
  return m;
}
