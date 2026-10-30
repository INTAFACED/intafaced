import type { OtcMakers, RfqBoard as Board, RfqBoardStatus } from '../rooms/api';
import { roomWords } from '../rooms/refusals';
import { Refusal } from '../rooms/RoomNotices';
import { Badge, Button, Skeleton, fmtAmount, fmtPrice, type Loadable } from '../rooms/ui';
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
    <section aria-label={t('Your requests')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <h2 className="m-0 text-md font-medium text-fg">{t('Your requests')}</h2>
      <p className="m-0 text-sm text-fg-2">{t('Board lead')}</p>
      {board.status === 'loading' ? <Skeleton className="h-24 w-full" aria-label={t('Board loading')} /> : null}
      {board.status === 'refused' ? <Refusal words={roomWords({ code: board.code })} size="inline" /> : null}
      {board.status === 'error' ? (
        <div className="flex items-center gap-3 text-sm text-fg-2">
          {t('Board unreadable')}
          <Button variant="secondary" size={28} onClick={board.retry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {board.status === 'ready'
        ? board.data.groups.map((group) => (
            <div key={group.status} data-testid="board-group" data-status={group.status} className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-medium text-fg">
                {t('Board group', { label: t(GROUP_WORD[group.status]), count: String(group.count) })}
              </h3>
              {group.requests.length === 0 ? <p className="m-0 text-xs text-fg-2">{t('Board group empty')}</p> : null}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {group.requests.map((request) => (
                  <li key={request.rfqId} data-testid="board-request" data-rfq-id={request.rfqId} className="flex flex-col gap-1">
                    <span className="text-sm text-fg">
                      {t('Board request', {
                        side: request.side === 'buy' ? t('Board buy') : t('Board sell'),
                        qty: fmtAmount(request.qty),
                        base: request.baseAsset,
                        quote: request.quoteAsset,
                      })}
                    </span>
                    <ol className="m-0 flex list-none flex-col gap-1 p-0">
                      {request.quotes.map((quote) => (
                        <li
                          key={quote.quoteId}
                          data-testid="board-quote"
                          data-quote-id={quote.quoteId}
                          data-rank={quote.rank}
                          data-maker-id={quote.makerId ?? ''}
                          className="flex flex-wrap items-center gap-2 text-sm text-fg tabular-nums"
                        >
                          <span data-testid="board-quote-line">
                            {t('Board quote', {
                              provider: providerOf(quote.makerId),
                              price: fmtPrice(quote.quotedPrice, null),
                              asset: request.quoteAsset,
                            })}
                          </span>
                          {quote.best ? (
                            <Badge tone="lime" variant="outline" density="dense">
                              {t('Board best')}
                            </Badge>
                          ) : null}
                          {quote.test ? (
                            <Badge tone="warn" density="dense">
                              {t('Board test')}
                            </Badge>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
      {board.status === 'ready' && board.data.more ? <p className="m-0 text-xs text-fg-2">{t('Board more')}</p> : null}
    </section>
  );
}
