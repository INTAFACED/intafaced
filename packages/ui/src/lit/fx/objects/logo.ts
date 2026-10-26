/**
 * The logo is the light (ref b2-07): a thick dark glass tile, the mark inside glows and lights the tile's bevel; dust
 * drifts in the halo. `land` ramps the light up from off, as when money lands. Ported from take four's `FX.logo`;
 * the tile keeps r128's lighting through `legacyLit`.
 */
import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  Scene,
  ShaderMaterial,
  ShapeGeometry,
} from 'three';
import type { FxFactory } from '../engine.js';
import { markShapes, roundedRect } from './mark.js';
import { dotTexture, raw } from './shared.js';
import { legacyLit } from './legacy.js';

export interface LogoOptions {
  color: string;
  hot: string;
  dist?: number;
  /** Ramp the light up from off over about a second (money landing). */
  land?: boolean;
}

/** r128's legacy lights were PI times brighter than r186's physical ones at the same number. */
const LEGACY = Math.PI;
const EXPOSURE = 0.88;

export const logo: FxFactory<LogoOptions> = (ctx, o) => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, o.dist ?? 8);
  const acc = raw(o.color);
  const hot = raw(o.hot);
  scene.add(new AmbientLight(0xffffff, 0.06 * LEGACY));
  const tile = new Group();
  scene.add(tile);
  const tg = new ExtrudeGeometry(roundedRect(2, 0.5), {
    depth: 0.22,
    bevelEnabled: true,
    bevelThickness: 0.07,
    bevelSize: 0.07,
    bevelSegments: 6,
    curveSegments: 24,
  });
  tg.translate(0, 0, -0.22);
  tile.add(new Mesh(tg, legacyLit(new MeshStandardMaterial({ color: raw('#0a0807'), roughness: 0.22, metalness: 0.35 }), EXPOSURE))); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  const L = new PointLight(acc, 0, 3.2, 1.6);
  L.position.set(0, 0, 0.35);
  tile.add(L);
  const rim = new DirectionalLight(0xffffff, 0.25 * LEGACY);
  rim.position.set(-2, 3, 2);
  scene.add(rim);
  const mg = new ExtrudeGeometry(markShapes(), {
    depth: 0.06,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.015,
    bevelSegments: 2,
  });
  mg.translate(0, 0, 0.09);
  const MU = { uAcc: { value: acc }, uHot: { value: hot }, uOn: { value: o.land ? 0 : 1 } };
  const mark = new Mesh(
    mg,
    new ShaderMaterial({
      uniforms: MU,
      vertexShader: 'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'uniform vec3 uAcc,uHot;uniform float uOn;varying vec3 vP;void main(){float d=length(vP.xy-vec2(.0,-.05));vec3 c=mix(mix(uHot,uAcc,.72)*.66,uAcc*vec3(.6,.48,.42),smoothstep(.0,.42,d));gl_FragColor=vec4(c*(.06+.94*uOn),1.);}',
    }),
  );
  mark.scale.setScalar(0.82);
  tile.add(mark);
  // light inside the glass, falling off to the edges, and the thin bright rim
  const face = new Mesh(
    new ShapeGeometry(roundedRect(2.1, 0.55), 24),
    new ShaderMaterial({
      uniforms: { uAcc: MU.uAcc, uOn: MU.uOn },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: 'varying vec2 vP;void main(){vP=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'uniform vec3 uAcc;uniform float uOn;varying vec2 vP;void main(){float d=length(vP)/1.05;float g=pow(max(0.,1.-d*.92),1.35)*.8*uOn;vec2 q=abs(vP)-vec2(1.05-.55);float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-.55;float rim=smoothstep(.022,0.,abs(sd+.012))*(.22+.18*uOn)*(.6+.4*smoothstep(-1.,1.,vP.y-vP.x*.3));vec3 c=uAcc*vec3(.9,.55,.45)*g+vec3(1.,.93,.88)*rim;float a=max(g,rim);gl_FragColor=vec4(c,a);}',
    }),
  );
  face.position.z = 0.072;
  tile.add(face);
  // dust in the halo
  const N = ctx.tier === 'lite' ? 350 : 700;
  const dp = new Float32Array(N * 3);
  const ds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = ctx.rand() * Math.PI * 2;
    const rr = 1.25 + Math.pow(ctx.rand(), 0.6) * 1.9;
    dp[i * 3] = Math.cos(a) * rr * 1.25;
    dp[i * 3 + 1] = Math.sin(a) * rr * 0.95;
    dp[i * 3 + 2] = (ctx.rand() - 0.5) * 1.5;
    ds[i] = ctx.rand();
  }
  const dg = new BufferGeometry();
  dg.setAttribute('position', new BufferAttribute(dp, 3));
  dg.setAttribute('rnd', new BufferAttribute(ds, 1));
  const DU = { uAcc: MU.uAcc, uT: { value: 0 }, uOn: MU.uOn, uTex: { value: dotTexture() }, uS: { value: 2.4 * ctx.dpr } };
  const dust = new Points(
    dg,
    new ShaderMaterial({
      uniforms: DU,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader:
        'attribute float rnd;uniform float uT,uS;varying float vA;void main(){vec3 p=position;p.y+=sin(uT*.3+rnd*20.)*.06;p.x+=cos(uT*.25+rnd*14.)*.05;vec4 mv=modelViewMatrix*vec4(p,1.);vA=(.35+.65*fract(rnd*7.+uT*.08*(rnd-.5)))*(1.-smoothstep(2.2,3.3,length(p.xy)));gl_PointSize=uS*(.4+rnd)*(4./-mv.z);gl_Position=projectionMatrix*mv;}',
      fragmentShader:
        'uniform vec3 uAcc;uniform float uOn;uniform sampler2D uTex;varying float vA;void main(){float a=texture2D(uTex,gl_PointCoord).a*vA*1.4*uOn;gl_FragColor=vec4(mix(uAcc,vec3(1.,.85,.7),.35)*a,a);}',
    }),
  );
  scene.add(dust);
  // anamorphic streak behind the tile, and a haze
  const glow = (w: number, h: number, z: number, frag: string) => {
    const m = new Mesh(
      new PlaneGeometry(w, h),
      new ShaderMaterial({
        uniforms: { uAcc: MU.uAcc, uOn: MU.uOn },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: 'varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: frag,
      }),
    );
    m.position.z = z;
    scene.add(m);
  };
  glow(
    7.5,
    0.5,
    -0.6,
    'uniform vec3 uAcc;uniform float uOn;varying vec2 vU;void main(){float x=abs(vU.x-.5)*2.,y=abs(vU.y-.5)*2.;float a=pow(1.-x,2.5)*pow(1.-y,6.)*.55*uOn;gl_FragColor=vec4(uAcc*a,a);}',
  );
  glow(
    12,
    9,
    -1.5,
    'uniform vec3 uAcc;uniform float uOn;varying vec2 vU;void main(){vec2 q=(vU-.5)*vec2(1.33,1.);float a=pow(max(0.,1.-length(q)*1.6),2.)*.16*uOn;gl_FragColor=vec4(uAcc*a,a);}',
  );
  const t0 = o.land ? 0.35 : -10;
  return {
    scene,
    camera,
    bloom: ctx.tier === 'lite' ? null : { strength: 0.7, radius: 0.85, threshold: 0.24 },
    exposure: EXPOSURE,
    animated: true,
    tick(t) {
      const on = o.land && !ctx.still ? Math.min(1, Math.max(0, (t - t0) / 1.1)) : 1;
      const e = 1 - Math.pow(1 - on, 3);
      MU.uOn.value = e;
      L.intensity = 5 * e * LEGACY;
      DU.uT.value = t;
      tile.rotation.y = -0.22 + Math.sin(t * 0.35) * 0.1;
      tile.rotation.x = 0.16 + Math.sin(t * 0.27) * 0.05;
      tile.position.y = Math.sin(t * 0.6) * 0.04;
      dust.rotation.z = t * 0.01;
    },
    setColor(accent, h) {
      MU.uAcc.value.copy(raw(accent));
      L.color.copy(raw(accent));
      if (h) MU.uHot.value.copy(raw(h));
    },
  };
};
