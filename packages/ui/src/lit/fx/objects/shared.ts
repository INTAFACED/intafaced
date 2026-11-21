import { CanvasTexture, Color, LinearSRGBColorSpace } from 'three';

/**
 * A colour taken as written, with no sRGB-to-linear conversion: take four's shaders were tuned in r128, where hex
 * colours reached the screen unchanged. Used by the `raw` objects so the port looks the same.
 */
export function raw(hex: string): Color {
  return new Color().setStyle(hex, LinearSRGBColorSpace);
}

let dot: CanvasTexture | null = null;
/** The soft round sprite every particle uses. Shared, so it is created once per page. */
export function dotTexture(): CanvasTexture {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
    gr.addColorStop(0.25, 'rgba(255,255,255,.85)'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
    gr.addColorStop(0.6, 'rgba(255,255,255,.12)'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
    gr.addColorStop(1, 'rgba(255,255,255,0)'); // look-drift-allow: pixel painted into a WebGL texture, CSS roles cannot reach it
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  }
  dot = new CanvasTexture(c);
  // the engine disposes textures with their material; this one is shared, so it re-uploads on next use
  return dot;
}
