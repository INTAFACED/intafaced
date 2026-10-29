import { navigate } from '../../app/location';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Page, Panel } from '../../shared/ui';
import { protocolCopy as copy } from './copy';
import type { PendingBlocker, PendingPage, Web3Room } from './routes';
import './protocol.css';

type Header =
  | 'hdr_pair'
  | 'hdr_liquidity'
  | 'hdr_time'
  | 'hdr_pool'
  | 'hdr_range'
  | 'hdr_token'
  | 'hdr_price'
  | 'hdr_balance'
  | 'hdr_event'
  | 'hdr_status'
  | 'hdr_block'
  | 'hdr_hash'
  | 'hdr_from'
  | 'hdr_to'
  | 'hdr_amount'
  | 'hdr_validator'
  | 'hdr_stake';
type What = 'what_pool' | 'what_position' | 'what_token' | 'what_block' | 'what_tx' | 'what_address' | 'what_validator';

/** The table a finished page will show. Headers only: a page that waits on a blocker has no rows to invent. */
const HEADERS: Record<PendingPage, readonly Header[]> = {
  poolNew: ['hdr_pair', 'hdr_liquidity'],
  poolDetail: ['hdr_pair', 'hdr_liquidity', 'hdr_time'],
  positionDetail: ['hdr_pool', 'hdr_range', 'hdr_liquidity'],
  blockDetail: ['hdr_block', 'hdr_time', 'hdr_status'],
  txDetail: ['hdr_hash', 'hdr_from', 'hdr_to', 'hdr_status'],
  addressDetail: ['hdr_hash', 'hdr_time', 'hdr_amount'],
  validatorDetail: ['hdr_validator', 'hdr_stake', 'hdr_status'],
};
const WHAT: Partial<Record<PendingPage, What>> = {
  poolDetail: 'what_pool',
  positionDetail: 'what_position',
  blockDetail: 'what_block',
  txDetail: 'what_tx',
  addressDetail: 'what_address',
  validatorDetail: 'what_validator',
};
const ROOM_KEY = { dex: 'roomDex', chain: 'roomChain', protocol: 'roomProtocol', wallet: 'roomWallet' } as const;
const ROOM_HOME: Record<Web3Room, string> = { dex: '/dex', chain: '/chain', protocol: '/protocol', wallet: '/wallet' };

/**
 * A Web3 route whose data source is not built yet. It keeps its full layout and says which blocker stands in front of it
 * (`data-blocker`). A malformed id is answered `protocol.not_found` instead of looking anything up.
 */
export function PendingRoute({
  room,
  page,
  blocker,
  param,
  valid,
}: {
  room: Web3Room;
  page: PendingPage;
  blocker: PendingBlocker;
  /** The id from the address bar, shown back as text. */
  param?: string;
  valid: boolean;
}) {
  const { language } = usePreferences();
  const { t } = copy.forLocale(language);
  const title = t(`page_${page}`);
  const what = WHAT[page];
  const headers = HEADERS[page].map((key) => t(key));
  return (
    <div className="legacy-room protocol-room" lang={copy.forLocale(language).renderedLocale} data-route={page}>
      <Page
        title={param && valid ? `${title} ${param}` : title}
        description={t('pendingNote')}
        eyebrow={
          <>
            <span>{t('bannerLine')}</span>
            <span className="badge protocol-pill">{t('bannerPill')}</span>
          </>
        }
      >
        {valid ? (
          <Panel title={t('pendingBlockedBy')}>
            <DataTable label={title} headers={headers}>
              <tr>
                <td colSpan={headers.length}>
                  <div data-blocker={blocker} role="status">
                    <EmptyState title={t(`blocker_${blocker}`)} />
                  </div>
                </td>
              </tr>
            </DataTable>
          </Panel>
        ) : (
          <Panel title={t('pendingNotFoundTitle')}>
            <div data-code="protocol.not_found" role="status">
              <EmptyState title={t('pendingNotFoundBody', { what: what ? t(what) : title })} />
            </div>
          </Panel>
        )}
        <Button variant="secondary" onClick={() => navigate(ROOM_HOME[room])}>
          {t('pendingBack', { room: t(ROOM_KEY[room]) })}
        </Button>
      </Page>
    </div>
  );
}

const ROOT_OF = /^\/(dex|chain|protocol|wallet)(?:\/|$)/;

/** A path under a Web3 room that no route claims: the room's own not-found page with a way back, never an empty page. */
export function NotFoundRoute({ path }: { path: string }) {
  const { language } = usePreferences();
  const { t } = copy.forLocale(language);
  const room = (ROOT_OF.exec(path)?.[1] ?? 'dex') as Web3Room;
  return (
    <div className="legacy-room protocol-room" lang={copy.forLocale(language).renderedLocale} data-route="not-found">
      <Page title={t('pendingNotFoundTitle')} description={t('pendingNote')}>
        <Panel title={t('pendingNotFoundTitle')}>
          <div data-code="protocol.not_found" role="status">
            <EmptyState title={t('notFoundPage')} />
          </div>
        </Panel>
        <Button variant="secondary" onClick={() => navigate(ROOM_HOME[room])}>
          {t('pendingBack', { room: t(ROOM_KEY[room]) })}
        </Button>
      </Page>
    </div>
  );
}
