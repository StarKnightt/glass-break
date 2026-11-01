import { CustomBlending, ZeroFactor, SrcColorFactor, CanvasTexture, Color, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

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
        // dark tinted shadow body (soft-edged), clipped at the neck tip
        float body = smoothstep(w, w * 0.75, abs(x)) * smoothstep(0.85, 1.05, d) * smoothstep(1.0, 0.94, s);
        // thin bright lens-focus band down the axis and a crescent hugging the base
        float focusLine = exp(-pow(x / 0.05, 2.0)) * smoothstep(1.1, 1.7, d) * smoothstep(0.55, 0.3, s);
        float crescent = exp(-pow((d - 1.2 - 0.3 * x * x) / 0.08, 2.0)) * smoothstep(0.8, 0.2, abs(x));
        float wav = 0.5 + 0.5 * sin(x * 17.0 + sin(d * 2.7 + uTime * 0.4) * 1.5 + d * 1.1);
        wav = pow(wav, 12.0);
        float clear = step(0.75, min(uTint.r, min(uTint.g, uTint.b)));
        float dark = mix(0.3, 0.62, clear) * (1.0 - uFill * 0.35);
        vec3 tn = mix(vec3(dot(uTint, vec3(0.333))), uTint, 0.55) / max(max(uTint.r, uTint.g), uTint.b);
        vec3 shade = mix(vec3(1.0), tn * dark, body);
        float boost = (focusLine * 0.55 + crescent * 0.6 + wav * 0.25) * body * (1.0 + uFill * 0.4);
        vec3 c = min(shade + tn * boost, vec3(1.4));
        float clip = smoothstep(uRailZ.x, uRailZ.x + 0.01, vW.z) * smoothstep(uRailZ.y, uRailZ.y - 0.01, vW.z);
        c = mix(vec3(1.0), c, clip * uStrength);
        gl_FragColor = vec4(c, 1.0);
      }`,
    transparent: true,
    blending: CustomBlending,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
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
