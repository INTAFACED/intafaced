import { SECTIONS } from './developers-model';
import { REST_REFERENCE, STREAM_REFERENCE, routeLine } from './developers-reference';

export type DocsMatch = { href: string; title: string };

/**
 * The developer docs search: every section and the base-address page by title in the reader's language, and the API
 * reference by the routes and streams it lists. A query matches when every word of it is in one page's text.
 */
export function searchDocs(query: string, sectionTitle: (id: string) => string, hostsTitle: string): DocsMatch[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const referenceText = [
    ...REST_REFERENCE.flatMap((route) => [routeLine(route), route.name]),
    ...STREAM_REFERENCE.map((s) => s.channel),
  ].join(' ');
  const pages = [
    ...SECTIONS.map((section) => ({
      href: `/developers/${section.id}`,
      title: sectionTitle(section.id),
      text: `${sectionTitle(section.id)} ${section.id} ${section.id === 'reference' ? referenceText : ''}`,
    })),
    { href: '/developers/hosts', title: hostsTitle, text: `${hostsTitle} hosts` },
  ];
  return pages
    .filter((page) => {
      const text = page.text.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map(({ href, title }) => ({ href, title }));
}
