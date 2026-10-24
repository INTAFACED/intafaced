/**
 * The status badge (SP-status-05): the page's top level or one component, as JSON and as a small SVG another page can
 * show with an <img>. Built by this service from the same page a visitor reads; no script, no personal data, no
 * third-party frame. Cached no longer than the staleness window, and not at all while that window is unset.
 */
import { STATUS_BADGE_LABELS, STATUS_BADGE_MAX_AGE_SECONDS, type StatusBadge, type StatusPage } from '@intafaced/contracts';

/** The badge for the whole page (componentId null) or one component; null when the page defines no such component. */
export function statusBadge(page: StatusPage, componentId: string | null): StatusBadge | null {
  const at = Date.parse(page.asOf);
  const window = page.settings.stalenessSeconds ?? 0;
  // A state that rests on a reading may be cached only for what is left of that reading's freshness, so a cached image
  // never says operational after the page has gone to no data.
  const left = (component: StatusPage['components'][number]) =>
    component.basis === 'reading' && component.reading
      ? Math.max(0, Math.floor(window - (at - Date.parse(component.reading.observedAt)) / 1000))
      : window;
  const cap = (seconds: number) => Math.max(0, Math.min(seconds, window, STATUS_BADGE_MAX_AGE_SECONDS));
  if (componentId === null)
    return {
      componentId: null,
      name: 'Platform status',
      state: page.overall,
      label: STATUS_BADGE_LABELS[page.overall],
      maxAgeSeconds: cap(Math.min(window, ...page.components.map(left))),
      asOf: page.asOf,
    };
  const component = page.components.find((c) => c.id === componentId);
  if (!component) return null;
  return {
    componentId,
    name: component.name,
    state: component.state,
    label: STATUS_BADGE_LABELS[component.state],
    maxAgeSeconds: cap(left(component)),
    asOf: page.asOf,
  };
}

const COLOURS: Readonly<Record<StatusBadge['state'], string>> = {
  operational: '#1a7f37',
  degraded: '#9a6700',
  partial_outage: '#bc4c00',
  major_outage: '#cf222e',
  maintenance: '#0969da',
  no_data: '#57606a',
  none_defined: '#57606a',
};

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Approximate width for an 11px sans-serif label, wide scripts counted wider; the text is then fitted to it exactly. */
const width = (text: string) => Math.ceil([...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 11 : 7), 0)) + 12;

/** A two-part badge, name on the left and state on the right, with a title for screen readers. */
export function statusBadgeSvg(badge: StatusBadge): string {
  const left = escape(badge.name);
  const right = escape(badge.label);
  const lw = width(badge.name);
  const rw = width(badge.label);
  const total = lw + rw;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${left}: ${right}">`,
    `<title>${left}: ${right}</title>`,
    `<rect width="${lw}" height="20" fill="#24292f"/>`,
    `<rect x="${lw}" width="${rw}" height="20" fill="${COLOURS[badge.state]}"/>`,
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `<text x="${lw / 2}" y="14" textLength="${lw - 12}" lengthAdjust="spacingAndGlyphs">${left}</text>`,
    `<text x="${lw + rw / 2}" y="14" textLength="${rw - 12}" lengthAdjust="spacingAndGlyphs">${right}</text>`,
    `</g></svg>`,
  ].join('');
}

/** The Cache-Control header for a badge: public up to its max age, or not cached at all. */
export const statusBadgeCacheControl = (badge: StatusBadge) =>
  badge.maxAgeSeconds > 0 ? `public, max-age=${badge.maxAgeSeconds}` : 'no-cache, max-age=0';
