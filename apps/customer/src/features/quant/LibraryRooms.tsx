// volt-room: /quant/library
import { QUANT_LIBRARY_TAGS, type QuantLibraryTag } from '@intafaced/contracts/quant-library';
import { QUANT_LIBRARY_BROWSE } from '@intafaced/contracts/quant-library-procedures';
import { useState } from 'react';
import { Button, EmptyState, Select } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { ReadView, RecordTable } from '../../shared/record/record-parts';
import { preservePaperHref } from '../more';
import { useApi } from '../session';
import { libraryCopy } from './library-copy';
import { QuantRooms } from './QuantRooms';

const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');
/** How many listings one page of the library reads. A page size, not a product limit. */
const PAGE = 20;

/** The strategy library (AL-library-02): open and protected listings in registration order, filtered by tag. */
export function LibraryRoom({ paper }: { paper: boolean }) {
  const { t } = libraryCopy.useCopy();
  const [tag, setTag] = useState<QuantLibraryTag | ''>('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <RecordListTemplate
      title={t('libraryTitle')}
      description={t('libraryIntro')}
      state={{ kind: 'ready' }}
      section={<QuantRooms paper={paper} />}
      list={
        <section>
          <h2>{t('libraryTitle')}</h2>
          <div data-testid="quant-library" data-tag={tag}>
            <Select
              label={t('filterTag')}
              value={tag}
              onChange={(value) => {
                setTag(QUANT_LIBRARY_TAGS.find((row) => row === value) ?? '');
                setCursors([null]);
              }}
              options={[{ value: '', label: t('allTags') }, ...QUANT_LIBRARY_TAGS.map((row) => ({ value: row, label: t(`tag_${row}`) }))]}
            />
            {cursors.map((cursor, i) => (
              <LibraryPage
                key={`${tag}:${cursor ?? 'first'}`}
                tag={tag || null}
                cursor={cursor}
                first={i === 0}
                last={i === cursors.length - 1}
                paper={paper}
                onMore={(next) => setCursors((prev) => [...prev, next])}
              />
            ))}
          </div>
        </section>
      }
    />
  );
}

function LibraryPage({
  tag,
  cursor,
  first,
  last,
  paper,
  onMore,
}: {
  tag: QuantLibraryTag | null;
  cursor: string | null;
  first: boolean;
  last: boolean;
  paper: boolean;
  onMore: (cursor: string) => void;
}) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const page = useResource(
    (signal) => api.call(QUANT_LIBRARY_BROWSE, { tag, limit: PAGE, cursor }, { signal }),
    `quant-library:${tag ?? ''}:${cursor ?? ''}`,
  );
  return (
    <ReadView resource={page.resource} retry={page.reload}>
      {(data) => (
        <>
          {data.entries.length === 0 && first ? (
            <EmptyState title={t('empty')} />
          ) : (
            <RecordTable
              label={t('libraryTitle')}
              headers={[t('colTitle'), t('colTags'), t('colVisibility'), t('colLicence'), t('colListed')]}
            >
              {data.entries.map((row) => (
                <tr key={row.listingId} data-testid="quant-library-row" data-listing-id={row.listingId} data-tags={row.tags.join(' ')}>
                  <td lang="und">
                    <a className="lt-link" href={preservePaperHref(`/quant/library/${encodeURIComponent(row.listingId)}`, paper)}>
                      {row.title}
                    </a>
                  </td>
                  <td>{row.tags.map((tagId) => t(`tag_${tagId}`)).join(', ')}</td>
                  <td>{t(`visibility_${row.visibility}`)}</td>
                  <td lang="und">{row.licence}</td>
                  <td lang="zxx">{utcText(row.listedAt)}</td>
                </tr>
              ))}
            </RecordTable>
          )}
          {last && data.nextCursor && (
            <Button tone="secondary" onClick={() => onMore(data.nextCursor!)}>
              {t('more')}
            </Button>
          )}
        </>
      )}
    </ReadView>
  );
}
