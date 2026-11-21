/**
 * The particle sphere lit from below (refs b1-09 bowl, b1-12 dome), ported from take four's r128 `FX.sphere`.
 * `mood` in -1..1 is today's change: how far up the light climbs and how fast the sphere breathes. `shares` splits
 * the lit crescent into holdings; they must add up to 1 (the honesty rule: parts reconcile to the total shown).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { FxFactory, FxScene } from '../engine.js';
import { SPHERE_SPAN } from '../sphere-layout.js';
import { dotTexture, raw } from './shared.js';

export interface SphereOptions {
  color: string;
  hot: string;
  /** Second segment colour; defaults to `hot`. */
  c1?: string;
  mood?: number;
  dist?: number;
  /** Vertical offset of the sphere in world units. */
  y?: number;
  tilt?: number;
  /** Point count before the tier cut. */
  n?: number;
  floor?: boolean;
  size?: number;
  /** Up to four holdings' shares of the total, summing to 1. */
  shares?: readonly number[];
  /** Screen positions (CSS px in the box) of the middle of each share, every frame, for callout lines. */
  onFrame?(points: Array<[number, number]>): void;
}

/** The lit crescent's half-width in radians (sphere-layout.ts places the page's labels with the same value). */
const SPAN = SPHERE_SPAN;

export function sharesAddUp(shares: readonly number[]): boolean {
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.length > 0 && shares.length <= 4 && shares.every((s) => s >= 0) && Math.abs(sum - 1) < 1e-6;
}

const VERTEX = `attribute float rnd;uniform float uTime,uReach,uSize,uSeg;uniform vec4 uCuts;uniform vec3 uCtr;varying float vI;varying float vR;varying float vF;varying float vK;varying float vG;
void main(){vec3 n=normalize(position);vec4 wp=modelMatrix*vec4(position,1.);vec3 wn=normalize((modelMatrix*vec4(n,0.)).xyz);
float below=dot(wn,normalize(vec3(0.,-1.,.28)));float lit=smoothstep(-uReach,.95,below);
float rim=pow(1.-abs(wn.z),2.2);float front=step(0.,wn.z);
float tw=.75+.25*sin(uTime*1.7+rnd*40.);
vI=lit*(.35+.65*rim)*tw;vF=front;vR=rnd;vec3 w=wp.xyz-uCtr;float f=(atan(w.x,-w.y)+1.2)/2.4;vK=f<uCuts.x?0.:f<uCuts.y?1.:f<uCuts.z?2.:3.;float e=min(min(abs(f-uCuts.x),abs(f-uCuts.y)),abs(f-uCuts.z));vG=uSeg*(1.-smoothstep(.008,.02,e));
vec4 mv=viewMatrix*wp;gl_PointSize=uSize*(.7+1.1*lit)*(6./-mv.z);gl_Position=projectionMatrix*mv;}`;

const FRAGMENT = `uniform vec3 uAcc,uHot,uC0,uC1,uC2,uC3;uniform float uSeg;uniform sampler2D uTex;varying float vI;varying float vR;varying float vF;varying float vK;varying float vG;
void main(){vec4 t=texture2D(uTex,gl_PointCoord);float i=vI*(.35+.65*vF)*(1.-vG*.92);
vec3 base=uSeg>.5?(vK<.5?uC0:vK<1.5?uC1:vK<2.5?uC2:uC3):uAcc;
vec3 c=mix(base*.55,base,smoothstep(.1,.6,i));c=mix(c,mix(base,uHot,.6),smoothstep(.8,1.,i)*(uSeg>.5&&vK>.5?0.:1.));
float a=t.a*(.3+.9*i);gl_FragColor=vec4(c*a,a);}`;

const FLOOR_VERTEX = `attribute float rnd;uniform float uSize;varying float vI;void main(){float d=length(position.xz);vI=smoothstep(2.6,.9,d)*smoothstep(.5,1.,d)*(.6+.4*rnd);vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=uSize*(.6+.8*vI)*(6./-mv.z);gl_Position=projectionMatrix*mv;}`;
const FLOOR_FRAGMENT = `uniform vec3 uAcc,uHot;uniform sampler2D uTex;varying float vI;void main(){float a=texture2D(uTex,gl_PointCoord).a*(.08+.9*vI*vI);vec3 c=mix(uAcc*.6,mix(uAcc,uHot,.35),vI);gl_FragColor=vec4(c*a,a);}`;

export const sphere: FxFactory<SphereOptions> = (ctx, o): FxScene => {
  if (o.shares && !sharesAddUp(o.shares)) throw new Error('sphere shares must be 1 to 4 non-negative parts adding up to 1');
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, o.dist ?? 5.4);
  const lite = ctx.tier === 'lite';
  const N = Math.round((o.n ?? 9000) * (lite ? 0.55 : 1));
  const pos = new Float32Array(N * 3);
  const rnd = new Float32Array(N);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = ga * i;
    pos[i * 3] = Math.cos(th) * rr;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(th) * rr;
    rnd[i] = ctx.rand();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('rnd', new BufferAttribute(rnd, 1));
  const mood = o.mood ?? 0;
  const U = {
    uAcc: { value: raw(o.color) },
    uHot: { value: raw(o.hot) },
    uTime: { value: 0 },
    uReach: { value: 0.35 + 0.25 * mood },
    uSize: { value: (o.size ?? 2.2) * ctx.dpr },
    uTex: { value: dotTexture() },
    uCuts: { value: new Vector4(2, 2, 2, 2) },
    uSeg: { value: o.shares ? 1 : 0 },
    uC0: { value: raw(o.color) },
    uC1: { value: raw(o.c1 ?? o.hot) },
    uC2: { value: raw(o.color).multiplyScalar(0.5) },
    uC3: { value: raw(o.color).multiplyScalar(0.28) },
    uCtr: { value: new Vector3(0, o.y ?? 0, 0) },
  };
  if (o.shares) {
    let c = 0;
    const cuts = o.shares.map((x) => (c += x));
    U.uCuts.value.set(cuts[0] ?? 2, cuts[1] ?? 2, cuts[2] ?? 2, 1.01);
  }
  const material = new ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
  const pts = new Points(g, material);
  const grp = new Group();
  grp.add(pts);
  grp.rotation.x = o.tilt ?? 0.32;
  scene.add(grp);
  // a floor of dots under the sphere, lit where the sphere meets it (b1-09)
  const FN = o.floor === false ? 0 : lite ? 1300 : 2600;
  // the lite floor keeps all 26 rings with half the dots in each
  const rings = lite ? 50 : 100;
  const fp = new Float32Array(FN * 3);
  const fr = new Float32Array(FN);
  for (let i = 0; i < FN; i++) {
    const ring = Math.floor(i / rings);
    const a = ((i % rings) / rings) * Math.PI * 2 + ring * 0.13;
    const rr = 0.55 + ring * 0.075;
    fp[i * 3] = Math.cos(a) * rr;
    fp[i * 3 + 1] = -1.0;
    fp[i * 3 + 2] = Math.sin(a) * rr;
    fr[i] = ctx.rand();
  }
  if (FN) {
    const fg = new BufferGeometry();
    fg.setAttribute('position', new BufferAttribute(fp, 3));
    fg.setAttribute('rnd', new BufferAttribute(fr, 1));
    grp.add(
      new Points(
        fg,
        new ShaderMaterial({
          uniforms: U,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          vertexShader: FLOOR_VERTEX,
          fragmentShader: FLOOR_FRAGMENT,
        }),
      ),
    );
  }
  if (o.y) grp.position.y = o.y;
  const v = new Vector3();
  const speed = 0.06 + 0.04 * Math.abs(mood);
  let anchors: Array<[number, number, number]> | null = null;
  if (o.onFrame && o.shares) {
    let c = 0;
    anchors = o.shares.map((x) => {
      const a = -SPAN + (c + x / 2) * 2 * SPAN;
      c += x;
      return [Math.sin(a) * 0.93, -Math.cos(a) * 0.93, 0.37];
    });
  }
  return {
    scene,
    camera,
    bloom: lite ? null : { strength: 1.25, radius: 0.6, threshold: 0.05 },
    exposure: 1.1,
    animated: true,
    tick(t, w, h) {
      U.uTime.value = t;
      pts.rotation.y = t * speed;
      const b = 1 + 0.014 * Math.sin(t * (0.9 + 0.6 * Math.abs(mood)));
      pts.scale.setScalar(b);
      if (o.onFrame && anchors) {
        o.onFrame(
          anchors.map((a) => {
            v.set(a[0], a[1], a[2]).normalize().multiplyScalar(b);
            // the shader cuts segments by world angle after the tilt, so anchors are placed in world space too
            v.add(grp.position).project(camera);
            return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h];
          }),
        );
      }
    },
    setColor(accent, hot) {
      U.uAcc.value = raw(accent);
      U.uC0.value = raw(accent);
      U.uC2.value = raw(accent).multiplyScalar(0.5);
      U.uC3.value = raw(accent).multiplyScalar(0.28);
      if (hot) {
        U.uHot.value = raw(hot);
        if (!o.c1) U.uC1.value = raw(hot);
      }
    },
  };
};
