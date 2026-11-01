import {
  Color,
  CustomBlending,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

export interface ShardUniforms {
  uShardTex: { value: Texture | null };
  uLabelA: { value: Texture | null };
  uLabelB: { value: Texture | null };
  uHasB: { value: number };
  uLabA: { value: Vector4 };
  uLabB: { value: Vector4 };
  uRot: { value: number };
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uTint: { value: Color };
}

export function shardUniforms(sunDir: Vector3, sunColor: Color): ShardUniforms {
  return {
    uShardTex: { value: null },
    uLabelA: { value: null },
    uLabelB: { value: null },
    uHasB: { value: 0 },
    uLabA: { value: new Vector4(-1, -1, 0, 1) },
    uLabB: { value: new Vector4(-1, -1, 0, 1) },
    uRot: { value: 0 },
    uSunDir: { value: sunDir },
    uSunColor: { value: sunColor },
    uTint: { value: new Color() },
  };
}

const VPARS = /* glsl */ `
uniform highp sampler2D uShardTex;
attribute float sid;
attribute float edge;
attribute vec4 luv;
varying float vEdge;
varying vec4 vLuv;
vec3 sQrot( vec4 q, vec3 v ) { return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v ); }
`;

/** Shard transforms come from a float texture: texel 2i = (pos, scale), 2i+1 = quaternion. */
function patchVertex(sh: WebGLProgramParametersWithUniforms, scaleExpr: string, hasNormal: boolean) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VPARS}`);
  if (hasNormal) {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
  vec4 sQn = texelFetch( uShardTex, ivec2( int( sid ) * 2 + 1, 0 ), 0 );
  objectNormal = sQrot( sQn, objectNormal );
  vEdge = edge; vLuv = luv;`,
    );
  }
  sh.vertexShader = sh.vertexShader.replace(
    '#include <begin_vertex>',
    `vec4 sA = texelFetch( uShardTex, ivec2( int( sid ) * 2, 0 ), 0 );
  vec4 sQ = texelFetch( uShardTex, ivec2( int( sid ) * 2 + 1, 0 ), 0 );
  vec3 transformed = sQrot( sQ, position * ${scaleExpr} ) + sA.xyz;`,
  );
}

const FPARS = /* glsl */ `
uniform sampler2D uLabelA, uLabelB;
uniform float uHasB, uRot;
uniform vec4 uLabA, uLabB;
uniform vec3 uSunDir, uSunColor, uTint;
varying float vEdge;
varying vec4 vLuv;
`;

function patchPaper(sh: WebGLProgramParametersWithUniforms) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${FPARS}`)
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
  float paperA = 0.0;
  if ( vLuv.z > 0.5 && vLuv.w > 0.0005 ) {
    float th = vLuv.x + uRot;
    vec2 la = vec2( mod( th - uLabA.z, 6.2831853 ) / uLabA.w, ( vLuv.y - uLabA.x ) / ( uLabA.y - uLabA.x ) );
    vec2 lb = vec2( mod( th - uLabB.z, 6.2831853 ) / uLabB.w, ( vLuv.y - uLabB.x ) / ( uLabB.y - uLabB.x ) );
    if ( all( greaterThan( la, vec2( 0.0 ) ) ) && all( lessThan( la, vec2( 1.0 ) ) ) ) {
      diffuseColor.rgb = texture2D( uLabelA, la ).rgb; paperA = 1.0;
    } else if ( uHasB > 0.5 && all( greaterThan( lb, vec2( 0.0 ) ) ) && all( lessThan( lb, vec2( 1.0 ) ) ) ) {
      diffuseColor.rgb = texture2D( uLabelB, lb ).rgb; paperA = 1.0;
    }
  }`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor, 0.85, paperA );`,
    );
}

/** Cheap non-transmissive shard glass: env reflection + fresnel alpha + hard sun glints, label paper opaque. */
export function createCheapMaterial(env: Texture | null, envRot: { x: number; y: number; z: number }, u: ShardUniforms) {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, envMapIntensity: 1.1 });
  if (env) {
    m.envMap = env;
    m.envMapRotation.set(envRot.x, envRot.y, envRot.z);
  }
  m.transparent = true;
  m.blending = CustomBlending;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.side = 2;
  m.customProgramCacheKey = () => 'shardCheap2';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    patchVertex(sh, 'max( sA.w, 0.0 )', true);
    patchPaper(sh);
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
  vec3 sV = normalize( vViewPosition );
  float sNoV = clamp( abs( dot( normal, sV ) ), 0.0, 1.0 );
  float sFres = pow( 1.0 - sNoV, 5.0 );
  vec3 sSun = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  vec3 sR = reflect( -sV, normal );
  float sG = max( dot( sR, sSun ), 0.0 );
  float isEdge = step( 0.75, vEdge );
  vec3 glint = uSunColor * ( pow( sG, 2500.0 ) * 30.0 + pow( sG, 300.0 ) * 5.0 + pow( sG, 40.0 ) * 0.8 );
  vec3 sHue = mix( uTint / max( max( uTint.r, uTint.g ), max( uTint.b, 1e-3 ) ), vec3( 1.0 ), 0.35 );
  float isBase = step( 1.5, vEdge );
  float sLit = max( dot( normal, sSun ), 0.0 );
  isEdge *= 1.0 - isBase;
  float sFwd = pow( max( dot( -sV, sSun ), 0.0 ), 6.0 );
  float sa = clamp( 0.1 + 0.6 * sFres + isEdge * 0.55 + isBase * 0.55, 0.0, 0.9 );
  vec3 rim = sHue * uSunColor * isEdge * ( 0.1 + 1.2 * sFwd + 0.3 * sLit );
  vec3 sBody = sHue * ( sHue * uTint * totalDiffuse * 0.25 * ( 1.0 + isBase * 0.5 ) + uSunColor * sFwd * 0.3 * ( 1.0 - isBase ) );
  vec3 sCol = sBody * sa + totalSpecular * ( 0.6 - 0.45 * isBase ) + glint * ( 1.0 - 0.85 * isBase ) + rim;
  gl_FragColor = paperA > 0.5 ? vec4( outgoingLight, 1.0 ) : vec4( sCol, sa );
`,
    );
  };
  return m;
}

export function createTransmissiveMaterial(env: Texture | null, envRot: { x: number; y: number; z: number }, u: ShardUniforms) {
  const m = new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.02,
    transmission: 1,
    ior: 1.52,
    thickness: 0.005,
    specularIntensity: 1,
    envMapIntensity: 0.8,
    side: 2,
  });
  if (env) {
    m.envMap = env;
    m.envMapRotation.set(envRot.x, envRot.y, envRot.z);
  }
  m.customProgramCacheKey = () => 'shardTrans2';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    patchVertex(sh, 'abs( sA.w )', true);
    patchPaper(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <transmission_fragment>',
        `material.transmissionAlpha = 1.0;
  if ( paperA < 0.5 ) {
  #include <transmission_fragment>
  }
  {
    vec3 tV = normalize( vViewPosition );
    vec3 tSun = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
    float tG = max( dot( reflect( -tV, normal ), tSun ), 0.0 );
    totalSpecular += ( 1.0 - paperA ) * uSunColor * ( pow( tG, 3000.0 ) * 20.0 + step( 0.75, vEdge ) * uTint * 0.08 );
  }`,
      );
  };
  return m;
}

export function createDepthMaterial(u: ShardUniforms) {
  const m = new MeshDepthMaterial({ alphaHash: true, opacity: 0.45 });
  m.customProgramCacheKey = () => 'shardDepth1';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uShardTex = u.uShardTex;
    patchVertex(sh, 'abs( sA.w )', false);
  };
  return m;
}

/** Instanced glass dust: tinted flakes that flash when they face the sun. */
export function createGlitterMaterial(sunDir: Vector3, sunColor: Color) {
  return new ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir }, uSunColor: { value: sunColor } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying vec3 vC; varying float vDust;
      void main() {
        vDust = clamp( 0.0012 / length( instanceMatrix[0].xyz ) - 1.0, 0.0, 2.0 );
        mat4 m = modelMatrix * instanceMatrix;
        vec4 w = m * vec4( position, 1.0 );
        vW = w.xyz;
        vN = normalize( mat3( m ) * normal );
        #ifdef USE_INSTANCING_COLOR
        vC = instanceColor;
        #else
        vC = vec3( 1.0 );
        #endif
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uSunColor;
      varying vec3 vN; varying vec3 vW; varying vec3 vC; varying float vDust;
      void main() {
        vec3 V = normalize( cameraPosition - vW );
        vec3 N = normalize( vN );
        if ( dot( N, V ) < 0.0 ) N = -N;
        float g = max( dot( reflect( -V, N ), uSunDir ), 0.0 );
        float f = pow( 1.0 - max( dot( N, V ), 0.0 ), 4.0 );
        float fw = pow( max( dot( -V, uSunDir ), 0.0 ), 6.0 );
        vec3 col = vC * uSunColor * ( 0.04 * ( 0.3 + max( dot( N, uSunDir ), 0.0 ) ) + fw * vDust * 0.5 )
          + uSunColor * ( pow( g, 250.0 ) * 70.0 + pow( g, 16.0 ) * 0.25 ) + vec3( 0.5, 0.6, 0.7 ) * f * 0.25;
        gl_FragColor = vec4( col, 0.5 );
      }`,
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: 2,
  });
}
