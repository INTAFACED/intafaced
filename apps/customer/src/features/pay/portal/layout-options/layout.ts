export type PortalLayout = 'a' | 'b' | 'c';

/** Query previews cannot be enabled in a production build, including local-test builds. */
export function parseLayout(search: string, development: boolean): PortalLayout | null {
  if (!development) return null;
  const value = new URLSearchParams(search).get('layout');
  return value === 'a' || value === 'b' || value === 'c' ? value : null;
}
export function currentLayout(): PortalLayout | null {
  return parseLayout(typeof location === 'undefined' ? '' : location.search, import.meta.env.DEV);
}
export function layoutHref(href: string, layout: PortalLayout): string {
  const url = new URL(href, 'https://preview.invalid');
  url.searchParams.set('layout', layout);
  return url.pathname + url.search + url.hash;
}
