import type { OtcMakers, RfqBoard as Board, RfqBoardStatus } from '../rooms/api';
import { roomWords } from '../rooms/refusals';
import { Button, Tag } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice, type Loadable } from '../rooms/ui';
import { Refusal } from '../options/notices';
import { otcCopy } from './copy';

const GROUP_WORD: Record<RfqBoardStatus, 'Board open' | 'Board accepted' | 'Board settled' | 'Board expired'> = {
  open: 'Board open',
  accepted: 'Board accepted',
  settled: 'Board settled',
  expired: 'Board expired',
};

/**
 * The caller's requests (CB-otc-02), as the desk groups them: one group per status with its count, each request with
 * every quote it collected, best first. The order and the counts are the service's; nothing is re-ranked here.
 */
export function RfqBoard({ board, makers }: { board: Loadable<Board>; makers: Loadable<OtcMakers> }) {
  const { t } = otcCopy.useCopy();
  const names = new Map(makers.status === 'ready' ? makers.data.makers.map((m) => [m.id, m.name] as const) : []);
  const providerOf = (id: string | null) => (id === null ? t('Board house') : (names.get(id) ?? t('Board unknown provider')));

  return (
    <section aria-label={t('Your requests')} className="lt-stack">
      <h2 className="lt-heading">{t('Your requests')}</h2>
      <p className="lt-hint">{t('Board lead')}</p>
      {board.status === 'loading' ? (
        <div role="status" aria-label={t('Board loading')}>
          <Skeleton shape="rows" count={3} />
        </div>
      ) : null}
      {board.status === 'refused' ? <Refusal words={roomWords({ code: board.code })} /> : null}
      {board.status === 'error' ? (
        <div className="lt-toolbar">
          <span className="lt-hint">{t('Board unreadable')}</span>
          <Button onClick={board.retry}>{t('Try again')}</Button>
        </div>
      ) : null}
      {board.status === 'ready'
        ? board.data.groups.map((group) => (
            <div key={group.status} data-testid="board-group" data-status={group.status} className="lt-stack">
              <h3 className="lt-heading">{t('Board group', { label: t(GROUP_WORD[group.status]), count: String(group.count) })}</h3>
              {group.requests.length === 0 ? <p className="lt-hint">{t('Board group empty')}</p> : null}
              <ul className="lt-list">
                {group.requests.map((request) => (
                  <li key={request.rfqId} data-testid="board-request" data-rfq-id={request.rfqId} className="lt-stack">
                    <span>
                      {t('Board request', {
                        side: request.side === 'buy' ? t('Board buy') : t('Board sell'),
                        qty: fmtAmount(request.qty),
                        base: request.baseAsset,
                        quote: request.quoteAsset,
                      })}
                    </span>
                    <ol className="lt-list">
                      {request.quotes.map((quote) => (
                        <li
                          key={quote.quoteId}
                          data-testid="board-quote"
                          data-quote-id={quote.quoteId}
                          data-rank={quote.rank}
                          data-maker-id={quote.makerId ?? ''}
                          className="lt-toolbar"
                        >
                          <span data-testid="board-quote-line">
                            {t('Board quote', {
                              provider: providerOf(quote.makerId),
                              price: fmtPrice(quote.quotedPrice, null),
                              asset: request.quoteAsset,
                            })}
                          </span>
                          {quote.best ? <Tag tone="accent">{t('Board best')}</Tag> : null}
                          {quote.test ? <Tag tone="neutral">{t('Board test')}</Tag> : null}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
      {board.status === 'ready' && board.data.more ? <p className="lt-hint">{t('Board more')}</p> : null}
    </section>
  );
}
