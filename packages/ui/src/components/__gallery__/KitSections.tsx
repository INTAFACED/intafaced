/**
 * The shared screen kit, one section per part, in every state. Mounted by Gallery.tsx.
 * `?only=table` (or input, page, figures) shows one section, which is how the screenshot script
 * takes one picture per part. All figures are TEST DATA.
 */
import * as React from 'react';
import { FiguresSection } from './sections/FiguresSection.js';
import { InputSection } from './sections/InputSection.js';
import { PageSection } from './sections/PageSection.js';
import { TableSection } from './sections/TableSection.js';

export const KIT_SECTIONS = [
  { id: 'table', label: 'Table', Component: TableSection },
  { id: 'input', label: 'Input and Field', Component: InputSection },
  { id: 'page', label: 'Page and EmptyState', Component: PageSection },
  { id: 'figures', label: 'Stat, KeyValue, Badge, StatusChip', Component: FiguresSection },
] as const;

export function KitSections() {
  const only = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('only');
  const shown = KIT_SECTIONS.filter((s) => only === null || s.id === only);
  return (
    <div data-slot="kit-sections">
      {only === null ? (
        <nav aria-label="Kit parts" className="mb-2 flex flex-wrap gap-4 text-sm text-fg-2">
          {KIT_SECTIONS.map((s) => (
            <a key={s.id} href={`?only=${s.id}`} className="hover:text-fg">
              {s.label}
            </a>
          ))}
        </nav>
      ) : (
        <a href="?" className="text-sm text-fg-2 hover:text-fg">
          All parts
        </a>
      )}
      {shown.map(({ id, Component }) => (
        <div key={id} data-kit-section={id}>
          <Component />
        </div>
      ))}
    </div>
  );
}
