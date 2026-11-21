/**
 * The one WebGL renderer behind every light object on a page. Loaded lazily (`import('./engine.js')` from index.ts),
 * so three.js is never in the first-paint bundle.
 *
 * How one canvas serves many objects: the one renderer draws each visible object in turn on its offscreen canvas and
 * hands the frame to that object's canvas in the page (as a bitmap, with no copy, where OffscreenCanvas exists). One WebGL context per page however many
 * objects (browsers drop the oldest after about 16), and each object stays in normal layout, so it scrolls with
 * the page instead of lagging behind a fixed overlay.
 *
 * Budgets kept here (plan v2, "Budgets"): pixel ratio at most 1.5, render on demand, ambient motion at most 30 fps,
 * nothing drawn offscreen or in a hidden tab, context loss falls back to the poster and rebuilds on restore.
 */
import {
  ACESFilmicToneMapping,
  Mesh,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { LegacyBloomPass } from './bloom.js';
import { seededRandom, FX_SEED, type Rand } from './random.js';
import { isSoftwareRenderer, type FxTier } from './tier.js';

/** Ambient motion (breathing, drifting dust) never needs more than this. */
export const AMBIENT_FPS = 30;

export interface FxContext {
  /** Seeded, so the same object draws the same points every time. */
  rand: Rand;
  tier: FxTier;
  /** Device pixels per CSS pixel this object renders at (already capped). */
  dpr: number;
  /** Drawn once at t = 0 (posters, reduced motion): an object that plays in shows its settled state. */
  still: boolean;
}

export interface FxBloom {
  strength: number;
  radius: number;
  threshold: number;
}

/** What an object factory returns. The engine owns the renderer, the bloom chain and the schedule. */
export interface FxScene {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Null draws without bloom (the `lite` tier always does). */
  bloom: FxBloom | null;
  /** Tone-mapping exposure of take four's stage for this object (it brightens the bloom's base copy). */
  exposure: number;
  /** Multiplier on the pixel ratio, for wide soft backgrounds that don't need full resolution. Default 1. */
  resolution?: number;
  /** Moves by itself. A still object is drawn once per change (size, colour) and then costs nothing. */
  animated: boolean;
  /** Advance to `t` seconds for a box of `w` x `h` CSS pixels. */
  tick(t: number, w: number, h: number): void;
  /** One-off GPU work that needs the renderer (an environment bake), run once before the first frame. */
  prepare?(renderer: WebGLRenderer): void;
  /** Change the accent without rebuilding. */
  setColor?(accent: string, hot?: string): void;
  dispose?(): void;
}

export type FxFactory<O> = (ctx: FxContext, opts: O) => FxScene;

export interface ViewOptions {
  tier: FxTier;
  /** True when the tier came from `?fx=` or `data-fx-tier`: tests then run even on a software renderer. */
  forced: boolean;
  /** Draw one frame at t = 0 and stop: screenshots, reduced motion. */
  still: boolean;
  seed?: number;
  onReady(): void;
  /** WebGL failed or the context was lost: show the poster. */
  onFail(reason: string): void;
}

interface View {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** How frames reach the page: a zero-copy bitmap hand-over, or a copy from the shared canvas. */
  present: ImageBitmapRenderingContext | CanvasRenderingContext2D;
  make: (ctx: FxContext) => FxScene;
  opts: ViewOptions;
  fx: FxScene | null;
  composer: EffectComposer | null;
  bloom: LegacyBloomPass | null;
  /** Capped device pixel ratio for the tier. */
  baseDpr: number;
  /** What this object renders at: baseDpr times its resolution. */
  dpr: number;
  w: number;
  h: number;
  wpx: number;
  hpx: number;
  visible: boolean;
  dirty: boolean;
  ready: boolean;
  t0: number;
  io: IntersectionObserver;
  ro: ResizeObserver;
}

let renderer: WebGLRenderer | null = null;
let rendererName = '';
let lost = false;
const views = new Set<View>();
let raf = 0;
let lastAmbient = 0;
/** Set once a software renderer was refused: later mounts refuse before creating a context. */
let refusedRenderer = '';
const scratch = new Vector2();

/** The renderer string, for tests that must fail loudly when WebGL silently changes. */
export function engineInfo(): { renderer: string; views: number; lost: boolean } {
  return { renderer: rendererName, views: views.size, lost };
}

function offscreenWebgl2(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** True when frames are handed over as bitmaps rather than copied. */
export function zeroCopy(): boolean {
  return typeof OffscreenCanvas === 'function' && renderer?.domElement instanceof OffscreenCanvas;
}

function getRenderer(): WebGLRenderer {
  if (renderer) return renderer;
  // An OffscreenCanvas hands each frame over as an ImageBitmap with no copy (Chrome 69, Safari 17, Firefox 105).
  // Older engines copy from a hidden canvas instead, which on a software-composited page reads pixels back.
  // `data-fx-present="copy"` on the root forces the copy path, to measure both on one device.
  const bitmap = document.documentElement.dataset.fxPresent !== 'copy' && typeof OffscreenCanvas === 'function' && offscreenWebgl2();
  const canvas: HTMLCanvasElement | OffscreenCanvas = bitmap ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const r = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
  r.setPixelRatio(1);
  r.setClearColor(0x000000, 1);
  r.setScissorTest(true);
  const gl = r.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  rendererName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  canvas.addEventListener('webglcontextlost', (event) => {
    // a renderer already given up (a refused software one) has no views to tell
    if (renderer?.domElement !== canvas) return;
    event.preventDefault();
    lost = true;
    for (const v of views) {
      teardown(v);
      v.opts.onFail('context-lost');
    }
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (renderer?.domElement !== canvas) return;
    lost = false;
    for (const v of views) build(v);
    schedule();
  });
  renderer = r;
  return r;
}

function disposeMaterial(m: Material): void {
  for (const value of Object.values(m)) {
    if (value && typeof value === 'object' && (value as Texture).isTexture) (value as Texture).dispose();
  }
  const uniforms = (m as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
  if (uniforms) {
    for (const u of Object.values(uniforms)) {
      if (u.value && typeof u.value === 'object' && (u.value as Texture).isTexture) (u.value as Texture).dispose();
    }
  }
  m.dispose();
}

function teardown(v: View): void {
  v.fx?.scene.traverse((o: Object3D) => {
    const mesh = o as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] };
    mesh.geometry?.dispose();
    if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(disposeMaterial);
  });
  v.fx?.dispose?.();
  v.composer?.dispose();
  v.fx = null;
  v.composer = null;
  v.bloom = null;
  v.ready = false;
}

function measure(v: View): void {
  const rect = v.el.getBoundingClientRect();
  v.w = Math.max(1, Math.round(rect.width));
  v.h = Math.max(1, Math.round(rect.height));
  v.wpx = Math.max(1, Math.round(v.w * v.dpr));
  v.hpx = Math.max(1, Math.round(v.h * v.dpr));
  if (v.canvas.width !== v.wpx) v.canvas.width = v.wpx;
  if (v.canvas.height !== v.hpx) v.canvas.height = v.hpx;
  if (v.fx) {
    v.fx.camera.aspect = v.w / v.h;
    v.fx.camera.updateProjectionMatrix();
  }
  v.composer?.setSize(v.wpx, v.hpx);
}

function build(v: View): void {
  const r = getRenderer();
  const fx = v.make({ rand: seededRandom(v.opts.seed ?? FX_SEED), tier: v.opts.tier, dpr: v.baseDpr, still: v.opts.still });
  v.fx = fx;
  v.dpr = v.baseDpr * (fx.resolution ?? 1);
  fx.prepare?.(r);
  if (fx.bloom && v.opts.tier === 'full' && document.documentElement.dataset.fxBloom !== 'off') {
    // 8-bit buffers and r128's bloom, as take four's composer had (bloom.ts says why not r186's)
    const composer = new EffectComposer(r, new WebGLRenderTarget(v.wpx, v.hpx, { type: UnsignedByteType }));
    composer.setPixelRatio(1);
    composer.addPass(new RenderPass(fx.scene, fx.camera));
    v.bloom = new LegacyBloomPass(new Vector2(v.wpx, v.hpx), fx.bloom.strength, fx.bloom.radius, fx.bloom.threshold);
    composer.addPass(v.bloom);
    v.composer = composer;
  }
  measure(v);
  v.dirty = true;
}

function draw(v: View, now: number): void {
  const r = renderer;
  const fx = v.fx;
  if (!r || !fx) return;
  const t = v.opts.still ? 0 : (now - v.t0) / 1000;
  fx.tick(t, v.w, v.h);
  const size = r.getSize(scratch);
  const bitmap = v.present instanceof ImageBitmapRenderingContext;
  // a bitmap is the whole canvas, so the canvas takes each object's size; a copy reads a corner of a canvas that only grows
  if (bitmap ? size.x !== v.wpx || size.y !== v.hpx : size.x < v.wpx || size.y < v.hpx)
    r.setSize(bitmap ? v.wpx : Math.max(size.x, v.wpx), bitmap ? v.hpx : Math.max(size.y, v.hpx), false);
  const height = r.getSize(scratch).y;
  r.setViewport(0, 0, v.wpx, v.hpx);
  r.setScissor(0, 0, v.wpx, v.hpx);
  // take four's r128 settings: ACES and sRGB output, which three applies only to built-in materials drawn on the
  // screen (the bloom's base copy), never to our shader materials or into the composer's buffers; lit materials
  // tone-map themselves wherever they draw (objects/legacy.ts)
  r.toneMapping = ACESFilmicToneMapping;
  r.toneMappingExposure = fx.exposure;
  r.outputColorSpace = SRGBColorSpace;
  if (v.composer) v.composer.render();
  else r.render(fx.scene, fx.camera);
  // the drawing buffer is still valid inside this task, so no preserveDrawingBuffer is needed
  if (v.present instanceof ImageBitmapRenderingContext)
    v.present.transferFromImageBitmap((r.domElement as unknown as OffscreenCanvas).transferToImageBitmap());
  else v.present.drawImage(r.domElement, 0, height - v.hpx, v.wpx, v.hpx, 0, 0, v.wpx, v.hpx);
  v.dirty = false;
  if (!v.ready) {
    v.ready = true;
    v.opts.onReady();
  }
}

function frame(now: number): void {
  raf = 0;
  if (lost || document.hidden) return;
  const ambientDue = now - lastAmbient >= 1000 / AMBIENT_FPS - 2;
  let moving = false;
  for (const v of views) {
    if (!v.visible || !v.fx) continue;
    const animated = v.fx.animated && !v.opts.still;
    if (animated) moving = true;
    if (v.dirty || (animated && ambientDue)) {
      try {
        draw(v, now);
      } catch (error) {
        teardown(v);
        v.opts.onFail(error instanceof Error ? error.message : 'draw-failed');
      }
    }
  }
  if (ambientDue) lastAmbient = now;
  if (moving) schedule();
}

function schedule(): void {
  if (!raf && views.size) raf = requestAnimationFrame(frame);
}

let pageHooked = false;
function hookPage(): void {
  if (pageHooked) return;
  pageHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
}

/** Gives the main thread back between start-up steps, so no single task blocks input (budget: none over 200 ms). */
function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Compiles every shader the object will draw with off the main thread where the browser can
 * (KHR_parallel_shader_compile, through `compileAsync`), instead of in one blocking first frame.
 */
async function precompile(v: View): Promise<void> {
  const r = renderer;
  if (!r || !v.fx) return;
  await r.compileAsync(v.fx.scene, v.fx.camera);
  if (v.bloom) {
    const quads = new Scene();
    const plane = new PlaneGeometry(2, 2);
    for (const m of v.bloom.materials()) quads.add(new Mesh(plane, m));
    await r.compileAsync(quads, v.fx.camera);
    plane.dispose();
  }
}

/**
 * Mounts one object in `canvas` (sized to `el`). Resolves to the unmount function once the object can draw; start-up
 * runs in small steps (context, scene, shaders) with the main thread given back between them. Rejects if WebGL can't
 * start.
 */
export async function mountView(
  el: HTMLElement,
  canvas: HTMLCanvasElement,
  make: (ctx: FxContext) => FxScene,
  opts: ViewOptions,
): Promise<() => void> {
  if (!opts.forced && refusedRenderer) throw new Error(`software renderer: ${refusedRenderer}`);
  const r = getRenderer();
  if (!opts.forced && isSoftwareRenderer(rendererName)) {
    // free the context now rather than keep a refused renderer for the whole session
    refusedRenderer = rendererName;
    if (!views.size) {
      r.dispose();
      r.forceContextLoss();
      renderer = null;
    }
    throw new Error(`software renderer: ${refusedRenderer}`);
  }
  const present = zeroCopy() ? canvas.getContext('bitmaprenderer') : canvas.getContext('2d', { alpha: false });
  if (!present) throw new Error('canvas context unavailable');
  hookPage();
  const dprCap = opts.tier === 'lite' ? 1 : 1.5;
  const v: View = {
    el,
    canvas,
    present,
    make,
    opts,
    fx: null,
    composer: null,
    bloom: null,
    baseDpr: Math.min(dprCap, window.devicePixelRatio || 1),
    dpr: 1,
    w: 1,
    h: 1,
    wpx: 1,
    hpx: 1,
    visible: true,
    dirty: true,
    ready: false,
    t0: performance.now(),
    io: new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        v.visible = entry ? entry.isIntersecting : true;
        if (v.visible) schedule();
      },
      { rootMargin: '64px' },
    ),
    ro: new ResizeObserver(() => {
      measure(v);
      v.dirty = true;
      schedule();
    }),
  };
  try {
    await yieldToMain();
    build(v);
    await yieldToMain();
    await precompile(v);
    await yieldToMain();
    if (lost || !v.fx) throw new Error('context-lost');
  } catch (error) {
    // a start-up that fails part-way frees what it built; nothing was observed yet
    teardown(v);
    throw error;
  }
  // the clock starts at the first frame, so that frame is t = 0: the poster's frame
  v.t0 = performance.now();
  views.add(v);
  v.io.observe(el);
  v.ro.observe(el);
  schedule();
  return () => {
    v.io.disconnect();
    v.ro.disconnect();
    views.delete(v);
    teardown(v);
  };
}

/** Re-colour every live object of a page (the accent switch). */
export function setAccent(accent: string, hot?: string): void {
  for (const v of views) {
    v.fx?.setColor?.(accent, hot);
    v.dirty = true;
  }
  schedule();
}
