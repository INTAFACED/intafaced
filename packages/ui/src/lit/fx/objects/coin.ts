/**
 * The coin is the light on its own page: a minted metal coin, rim lit from behind in the accent. Ported from take
 * four's `FX.coin`; the metal keeps r128's lighting through `legacyLit`.
 */
import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  CanvasTexture,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three';
import type { WebGLRenderer } from 'three';
import type { FxFactory } from '../engine.js';
import { legacyLit } from './legacy.js';
import { raw } from './shared.js';

export interface CoinOptions {
  color: string;
  /** The metal's colour. */
  metal?: string;
  /** A letter for the face; the default draws the bitcoin sign as B with two bars, so no font needs U+20BF. */
  glyph?: string;
}

const LEGACY = Math.PI;
const EXPOSURE = 1.15;
/**
 * r151 changed how bump maps read their texture, so r128's bump scales come out about 80 times flatter. 80 was the
 * best match to take four's frame in a sweep of 1 to 128 (26 Oct 2026: 2.0/255 mean difference per pixel, the rest
 * is the frame's time).
 */
const BUMP = 80;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d canvas unavailable');
  return [c, g];
}

export const coin: FxFactory<CoinOptions> = (ctx, o) => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, 0, 6.4);
  const acc = raw(o.color);
  const metal = raw(o.metal ?? '#F2A541'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  // environment: a studio strip and the accent from behind, baked once into a PMREM map
  const [ec, x] = canvas(256, 128);
  const gr = x.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#2a2a2a'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  gr.addColorStop(0.45, '#0a0a0a'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  gr.addColorStop(0.55, '#050505'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  gr.addColorStop(1, '#000'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  x.fillStyle = gr;
  x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#fff'; // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  x.fillRect(40, 30, 50, 10);
  x.fillStyle = o.color;
  x.fillRect(150, 50, 90, 30);
  // r128 read this one as linear, so no colour space is set
  const et = new CanvasTexture(ec);
  let envMap: Texture | null = null;
  let baker: WebGLRenderer | null = null;
  // the PMREM bake needs the renderer; it runs on first tick through `bake`
  const env = new Scene();
  env.add(new Mesh(new SphereGeometry(10, 32, 16), new MeshBasicMaterial({ map: et, side: BackSide })));
  // face: minted relief drawn to a canvas, used as colour and bump
  const [fc, f] = canvas(512, 512);
  const fg = f.createRadialGradient(200, 180, 20, 256, 256, 260);
  fg.addColorStop(0, '#ffffff'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  fg.addColorStop(1, '#bdbdbd'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  f.fillStyle = fg;
  f.fillRect(0, 0, 512, 512);
  f.strokeStyle = '#7a7a7a'; // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  f.lineWidth = 10;
  f.beginPath();
  f.arc(256, 256, 226, 0, Math.PI * 2);
  f.stroke();
  f.lineWidth = 3;
  f.beginPath();
  f.arc(256, 256, 206, 0, Math.PI * 2);
  f.stroke();
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    f.beginPath();
    f.moveTo(256 + Math.cos(a) * 212, 256 + Math.sin(a) * 212);
    f.lineTo(256 + Math.cos(a) * 220, 256 + Math.sin(a) * 220);
    f.stroke();
  }
  f.font = '600 270px Geist, system-ui, sans-serif';
  f.textAlign = 'center';
  f.textBaseline = 'middle';
  const glyph = (dx: number, dy: number, c: string) => {
    f.fillStyle = c;
    f.fillText(o.glyph ?? 'B', 256 + dx, 268 + dy);
    if (!o.glyph) {
      f.fillRect(222 + dx, 120 + dy, 18, 40);
      f.fillRect(266 + dx, 120 + dy, 18, 40);
      f.fillRect(222 + dx, 356 + dy, 18, 40);
      f.fillRect(266 + dx, 356 + dy, 18, 40);
    }
  };
  glyph(6, 6, '#6e6e6e'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  glyph(0, 0, '#f4f4f4'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
  const ft = new CanvasTexture(fc);
  ft.center.set(0.5, 0.5);
  ft.rotation = Math.PI / 2;
  ft.colorSpace = SRGBColorSpace;
  const bt = new CanvasTexture(fc);
  bt.center.set(0.5, 0.5);
  bt.rotation = Math.PI / 2;
  const face = legacyLit(
    new MeshStandardMaterial({
      color: metal,
      map: ft,
      bumpMap: bt,
      bumpScale: 0.025 * BUMP,
      metalness: 1,
      roughness: 0.32,
      envMapIntensity: 1.25,
    }),
    EXPOSURE,
  );
  // reeded edge
  const [rc, rx] = canvas(512, 8);
  for (let i = 0; i < 512; i += 4) {
    rx.fillStyle = i % 8 ? '#9a9a9a' : '#ffffff'; // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
    rx.fillRect(i, 0, 4, 8);
  }
  const rt = new CanvasTexture(rc);
  rt.wrapS = RepeatWrapping;
  rt.repeat.x = 6;
  const side = legacyLit(
    new MeshStandardMaterial({ color: metal, bumpMap: rt, bumpScale: 0.02 * BUMP, metalness: 1, roughness: 0.38, envMapIntensity: 1.1 }),
    EXPOSURE,
  );
  const disc = new Mesh(new CylinderGeometry(1, 1, 0.16, ctx.tier === 'lite' ? 64 : 128, 1), [side, face, face]);
  disc.rotation.x = Math.PI / 2;
  const grp = new Group();
  grp.add(disc);
  scene.add(grp);
  const key = new DirectionalLight(0xffffff, 1.3 * LEGACY);
  key.position.set(-2.5, 3, 4);
  scene.add(key);
  const back = new PointLight(acc, 26 * LEGACY, 6, 2);
  back.position.set(0.6, 0.4, -1.4);
  scene.add(back);
  scene.add(new AmbientLight(0xffffff, 0.08 * LEGACY));
  const HU = { uAcc: { value: acc } };
  const halo = new Mesh(
    new PlaneGeometry(4.6, 4.6),
    new ShaderMaterial({
      uniforms: HU,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: 'varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'uniform vec3 uAcc;varying vec2 vU;void main(){float d=length(vU-.5)*2.;float a=smoothstep(1.,.38,d)*.34;gl_FragColor=vec4(uAcc*a,a);}',
    }),
  );
  halo.position.z = -1.2;
  scene.add(halo);
  function bake(renderer: WebGLRenderer): void {
    baker = renderer;
    const pm = new PMREMGenerator(renderer);
    envMap = pm.fromScene(env, 0.02).texture;
    pm.dispose();
    face.envMap = envMap;
    side.envMap = envMap;
    face.needsUpdate = true;
    side.needsUpdate = true;
  }
  return {
    scene,
    camera,
    bloom: ctx.tier === 'lite' ? null : { strength: 0.9, radius: 0.6, threshold: 0.42 },
    exposure: EXPOSURE,
    animated: true,
    prepare(renderer) {
      if (!envMap) bake(renderer);
    },
    tick(t) {
      grp.rotation.y = -0.5 + Math.sin(t * 0.45) * 0.42;
      grp.rotation.x = 0.12 + Math.sin(t * 0.3) * 0.06;
      grp.position.y = Math.sin(t * 0.8) * 0.04;
    },
    setColor(accent) {
      HU.uAcc.value.copy(raw(accent));
      back.color.copy(raw(accent));
      // the accent is also in the reflections: repaint the strip and bake the environment again
      x.fillStyle = accent;
      x.fillRect(150, 50, 90, 30);
      et.needsUpdate = true;
      if (baker) {
        const old = envMap;
        bake(baker);
        old?.dispose();
      }
    },
    dispose() {
      envMap?.dispose();
      et.dispose();
      env.traverse((m) => {
        const mesh = m as Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as MeshBasicMaterial).dispose();
        }
      });
    },
  };
};
