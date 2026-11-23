/** A Blueprint card SVG is drawn only when it holds nothing but plain shapes and text: no entity, script, outside link or data URL. */
export function safeCardSvg(svg: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return false;
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') return false;
  const allowed = new Set([
    'svg',
    'g',
    'defs',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'path',
    'text',
    'tspan',
    'linearGradient',
    'radialGradient',
    'stop',
    'pattern',
    'clipPath',
    'mask',
    'title',
    'desc',
  ]);
  for (const element of [document.documentElement, ...document.documentElement.querySelectorAll('*')]) {
    if (!allowed.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
    for (const attr of element.attributes) {
      if (/^on/i.test(attr.localName) || ['href', 'src', 'base'].includes(attr.localName)) return false;
      if (attr.name === 'xmlns' || attr.name === 'xmlns:xlink') continue;
      const remainder = attr.value.replace(/url\(\s*#[a-zA-Z_][a-zA-Z0-9_-]*\s*\)/g, '');
      if (/url\s*\(|javascript:|data:|https?:|@import|expression\s*\(/i.test(remainder)) return false;
    }
  }
  return true;
}
