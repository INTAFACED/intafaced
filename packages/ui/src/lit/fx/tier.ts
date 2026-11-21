/**
 * Which tier of the light objects a device gets. Decided once per page from feature queries, before three.js loads,
 * so a weak device never downloads the 3D chunk.
 *
 * - `full`: real 3D with bloom, device pixel ratio capped at 1.5, ambient motion capped at 30 fps.
 * - `lite`: real 3D without bloom, at most 1x pixel ratio and fewer points.
 * - `poster`: the pre-rendered still of the same scene. Also the fallback whenever 3D fails or the context is lost.
 */
export type FxTier = 'full' | 'lite' | 'poster';

/** What the page knows about the device. Every field is optional because most browsers expose only some. */
export interface DeviceSignals {
  /** `?fx=full|lite|poster` or `data-fx-tier` on the root element: an explicit choice for tests and support. */
  forced?: string | null;
  webgl2: boolean;
  /** WebGL 2 created with `failIfMajorPerformanceCaveat`, i.e. on a GPU rather than a software renderer. */
  hardwareGl: boolean;
  reducedMotion: boolean;
  /** `navigator.connection.saveData` or `prefers-reduced-data: reduce`. */
  saveData: boolean;
  /** `navigator.deviceMemory` in GB (Chromium only). */
  deviceMemory?: number;
  /** `navigator.hardwareConcurrency`. */
  cores?: number;
  /** Narrow screens are phones; phones start on `lite` unless they look strong. */
  coarsePointer: boolean;
}

const TIERS: readonly FxTier[] = ['full', 'lite', 'poster'];

export function isTier(value: unknown): value is FxTier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** Pure decision, unit-tested. The weakest signal wins; an explicit choice wins over everything except missing WebGL 2. */
export function chooseTier(s: DeviceSignals): FxTier {
  if (!s.webgl2) return 'poster';
  if (isTier(s.forced)) return s.forced;
  if (!s.hardwareGl) return 'poster';
  if (s.reducedMotion || s.saveData) return 'poster';
  if (s.deviceMemory !== undefined && s.deviceMemory <= 2) return 'poster';
  if (s.cores !== undefined && s.cores <= 2) return 'poster';
  const weak = (s.deviceMemory !== undefined && s.deviceMemory <= 4) || (s.cores !== undefined && s.cores <= 4);
  if (weak) return 'lite';
  if (s.coarsePointer && s.deviceMemory === undefined && s.cores === undefined) return 'lite';
  return 'full';
}

/** Software WebGL (no GPU driver) draws every pixel on the CPU; such a device gets the poster. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render driver|microsoft basic/i.test(renderer);
}

function media(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

function hasWebgl2(failIfMajorPerformanceCaveat: boolean): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

let cached: FxTier | null = null;

/** Reads the browser once per page. `failIfMajorPerformanceCaveat` turns away most software renderers. */
export function deviceTier(): FxTier {
  if (cached) return cached;
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'poster';
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(location.search).get('fx') ?? document.documentElement.dataset.fxTier ?? null;
  } catch {
    forced = null;
  }
  const hardwareGl = hasWebgl2(true);
  cached = chooseTier({
    forced,
    webgl2: hardwareGl || hasWebgl2(false),
    hardwareGl,
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    saveData: nav.connection?.saveData === true || media('(prefers-reduced-data: reduce)'),
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    coarsePointer: media('(pointer: coarse)'),
  });
  return cached;
}

/** Tests only: forget the cached answer. */
export function resetDeviceTier(): void {
  cached = null;
}
