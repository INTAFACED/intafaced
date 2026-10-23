import Link from 'next/link';
import { Chip } from '@/components/chip';
import { DESK_SECTION_UNWIRED, resolveCommonSections, type CommonDeskId, type CommonLink } from '@/lib/ops-desk/common-sections';
import type { DeskSpec, DeskView } from '@/lib/ops-desk/types';

/**
 * The common eight sections at the top of a module desk (OPS-founder-01). Each one says which of the desk's own sections fill
 * it and how many of their reads answered, which other console page fills it, or exactly why nothing can yet. Nothing is
 * hidden and nothing is counted that the desk did not read.
 */

function LinkList({ links }: { links: readonly CommonLink[] }) {
  return (
    <ul className="dk-stack">
      {links.map((l) => (
        <li key={l.href + l.label}>{l.href.startsWith('#') ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}</li>
      ))}
    </ul>
  );
}

export function DeskSectionSet({ setId, spec, view }: { setId: CommonDeskId; spec: DeskSpec | null; view: DeskView | null }) {
  const sections = resolveCommonSections(setId, spec);
  const byId = new Map(spec?.sections.map((s) => [s.id, s]) ?? []);
  return (
    <section className="dk-stack" data-testid="common-sections" aria-labelledby="h-common-sections">
      <h2 id="h-common-sections">Desk sections</h2>
      <p className="dk-muted">The same eight sections on every module desk. Each names what fills it here, or why nothing can yet.</p>
      <div className="dk-common">
        {sections.map(({ id, title, fill }) => {
          if (fill.kind === 'unwired') {
            return (
              <article key={id} className="adm-callout" data-tone="warn" data-testid={`common-${id}`} data-state="unwired">
                <strong>{title}: no source</strong>
                <p>{fill.blocker}</p>
                <p className="dk-muted">Code: {DESK_SECTION_UNWIRED}</p>
                {fill.links && <LinkList links={fill.links} />}
              </article>
            );
          }
          const reads = fill.sections.flatMap((s) => byId.get(s)?.reads ?? []);
          const outcomes = reads.map((r) => view?.reads[r.id]).filter((o) => o !== undefined);
          const answered = outcomes.filter((o) => o.part.kind === 'ok').length;
          return (
            <article key={id} className="adm-callout" data-tone="info" data-testid={`common-${id}`} data-state="wired">
              <strong>{title}</strong>
              <p>{fill.note}</p>
              {reads.length > 0 && (
                <Chip tone={view !== null && answered === reads.length ? 'live' : 'warn'}>
                  {view === null ? `${reads.length} reads, none could be read` : `${answered} of ${reads.length} reads answered`}
                </Chip>
              )}
              {fill.sections.length > 0 && (
                <ul className="dk-row" aria-label={`${title}: sections on this desk`}>
                  {fill.sections.map((s) => (
                    <li key={s}>
                      <a href={`#${s}`}>{byId.get(s)?.title ?? s}</a>
                    </li>
                  ))}
                </ul>
              )}
              {fill.links && <LinkList links={fill.links} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
