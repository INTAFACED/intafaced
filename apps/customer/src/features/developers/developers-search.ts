import { SECTIONS } from './developers-model';
import { REST_REFERENCE, STREAM_REFERENCE, routeLine } from './developers-reference';

export type DocsMatch = { href: string; title: string };

/** What the API reference is found by: every route line, operation name and stream. Built once. */
const REFERENCE_TEXT = [...REST_REFERENCE.flatMap((route) => [routeLine(route), route.name]), ...STREAM_REFERENCE.map((s) => s.channel)]
  .join(' ')
  .toLocaleLowerCase();

/**
 * The developer docs search for one language: every section and the base-address page by title, and the API reference by
 * the routes and streams it lists. A query matches a page when every word of it is in that page's text. The index is
 * built once per language and each query's answer is kept.
 */
export function createDocsSearch(sectionTitle: (id: string) => string, hostsTitle: string): (query: string) => DocsMatch[] {
  const index = [
    ...SECTIONS.map((section) => ({
      href: `/developers/${section.id}`,
      title: sectionTitle(section.id),
      text: `${sectionTitle(section.id)} ${section.id} ${section.id === 'reference' ? REFERENCE_TEXT : ''}`.toLocaleLowerCase(),
    })),
    { href: '/developers/hosts', title: hostsTitle, text: `${hostsTitle} hosts`.toLocaleLowerCase() },
  ];
  const answers = new Map<string, DocsMatch[]>();
  return (query) => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const cacheKey = words.join(' ');
    const known = answers.get(cacheKey);
    if (known) return known;
    const found = words.length
      ? index.filter((page) => words.every((word) => page.text.includes(word))).map(({ href, title }) => ({ href, title }))
      : [];
    answers.set(cacheKey, found);
    return found;
  };
}
