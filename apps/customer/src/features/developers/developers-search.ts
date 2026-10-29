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
 * built once per language.
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
  return (query) => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return words.length
      ? index.filter((page) => words.every((word) => page.text.includes(word))).map(({ href, title }) => ({ href, title }))
      : [];
  };
}
