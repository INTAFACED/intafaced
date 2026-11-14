import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { Badge } from '@intafaced/ui';
import { useApi, useSession } from '../../features/session/session';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { createExplorerApi } from '../../features/protocol/explorer/explorer-api';
import { createVenueAccountApi } from '../../features/protocol/venue-wallet/venue-account-api';
import { WalletBar, useAsOfText, useOwner, useVenueApi } from '../../features/trade/venue/VenueKit';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { Amount, Button, fmtAmount, StateBlock, useActivity } from './deps';
import { stamp } from './time';
import type { ActivityFilters } from './activity-filter';
import { keepLine, oneList, partnerLines, unanswerable, venueLines, walletLines, type SourceLine } from './activity-sources';
import { sourcesCopy } from './activity-sources-copy';

type T = ReturnType<typeof sourcesCopy.useCopy>['t'];

/** A figure exactly as its source reports it, to every place it has: a source's fee of 0.000000175 is never shown rounded. */
const exact = (value: string) => fmtAmount(value, { places: 18 });

const FILTER_WORD = {
  note: 'filter note',
  account: 'filter account',
  year: 'filter year',
  address: 'filter address',
} as const;

/** How often the wallet and the venue are read again while the list is open. */
const READ_EVERY_MS = 3_000;
/** Every fill the venue keeps for the account: the venue's own list, from its first. */
const ALL_FILLS_SINCE = new Date(0).toISOString();

/**
 * /money/activity's All tab on the launch model (svc-trade's user-venue door on; J-portfolio-03 #1): the movements of the
 * person's money as each place holding it reports them, in one list, every line named with its source. Our own ledger is
 * not read for this list, as Assets reads none (WhereItSits).
 */
export function SourceActivity({
  status,
  filters,
  asset,
  hidden,
}: {
  status: VenueUp;
  filters: ActivityFilters;
  asset: string | null;
  hidden: boolean;
}) {
  const chainId = status.chainId ?? APP_CHAIN_ID;
  return (
    <WalletProvider chainId={chainId} scope="activity">
      <Sources status={status} chainId={chainId} filters={filters} asset={asset} hidden={hidden} />
    </WalletProvider>
  );
}

type Read<D> = { data: D | null; failure: unknown };
type Part = { state: 'reading' } | { state: 'unread' } | { state: 'off' } | { state: 'read'; lines: SourceLine[]; note: string };

function partOf<D>(read: Read<D>, lines: (data: D) => { lines: SourceLine[]; note: string }): Part {
  if (read.data) return { state: 'read', ...lines(read.data) };
  return read.failure ? { state: 'unread' } : { state: 'reading' };
}

function Sources({
  status,
  chainId,
  filters,
  asset,
  hidden,
}: {
  status: VenueUp;
  chainId: number;
  filters: ActivityFilters;
  asset: string | null;
  hidden: boolean;
}) {
  const { t } = sourcesCopy.useCopy();
  const { timeZone } = usePreferences();
  const asOfText = useAsOfText();
  const owner = useOwner();
  const transport = useApi();
  const { api, userId } = useSession();
  const explorer = useMemo(() => createExplorerApi(transport), [transport]);
  const venueAccount = useMemo(() => createVenueAccountApi(api), [api]);
  const venue = useVenueApi();
  const network = networkLabel(chainId).name;
  const venueName = status.venue.displayName;

  const wallet = usePolled(
    async (signal) => (owner ? explorer.addressTxs(chainId, owner, signal) : null),
    `activity:wallet:${chainId}:${owner ?? 'none'}`,
    READ_EVERY_MS,
  );
  const venueRead = usePolled(
    async (signal) => {
      if (!owner) return null;
      const [fills, deposits] = await Promise.all([venue.fills(owner, ALL_FILLS_SINCE, signal), venueAccount.deposits(owner, signal)]);
      if (!fills.ok) return fills;
      // A venue that publishes no deposit list still has its fills: the list says the deposits aren't offered.
      if (!deposits.ok && !/not_offered/.test(`${deposits.code ?? ''} ${deposits.message}`)) return deposits;
      return {
        ok: true as const,
        data: { fills: fills.data.value, deposits: deposits.ok ? deposits.data.value : [], asOf: fills.data.asOf },
      };
    },
    `activity:venue:${owner ?? 'none'}`,
    READ_EVERY_MS,
  );
  const bank = useActivity({});

  const walletPart: Part = owner
    ? partOf(wallet, (page) => ({
        lines: walletLines(page.rows, network),
        note: page.asOfHeight === null ? t('Wallet read no height') : t('Wallet read', { height: String(page.asOfHeight) }),
      }))
    : { state: 'off' };
  const venuePart: Part = owner
    ? partOf(venueRead, (read) => ({
        lines: venueLines(read.fills, read.deposits, venueName),
        note: t('Venue read', { name: venueName, time: asOfText(read.asOf) }),
      }))
    : { state: 'off' };
  const partnerItems = bank.status === 'ready' ? bank.data.items : [];
  const partner = partnerLines(partnerItems);
  const partnerName = partner[0]?.sourceName ?? null;
  const partnerPart: Part =
    bank.status === 'loading'
      ? { state: 'reading' }
      : bank.status === 'error' || bank.status === 'refused'
        ? { state: 'unread' }
        : partner.length > 0
          ? { state: 'read', lines: partner, note: t('Partner read', { name: partnerName ?? '' }) }
          : { state: 'off' };

  const blocked = unanswerable(filters);
  const all = oneList(
    [walletPart, venuePart, partnerPart].flatMap((part) => (part.state === 'read' ? part.lines : [])),
    filters.sort,
  );
  const shown = all.filter((line) => keepLine(line, filters, timeZone, asset, titleOf(line, t)));
  const narrowed = asset !== null || filters.q.trim() !== '' || filters.dir !== 'all' || filters.from !== '' || filters.to !== '';
  const anyReading = [walletPart, venuePart, partnerPart].some((part) => part.state === 'reading');

  return (
    <div data-testid="activity-by-source" data-user={userId ?? ''} className="form-stack">
      <p className="money-caption">{t('Lede')}</p>
      <WalletBar />
      <div className="money-sources">
        <SourceNote
          kind="wallet"
          part={walletPart}
          words={{ reading: t('Wallet reading'), unread: t('Wallet unread'), off: t('Wallet not connected') }}
        />
        <SourceNote
          kind="venue"
          part={venuePart}
          test={status.test}
          words={{ reading: t('Venue reading'), unread: t('Venue unread', { name: venueName }), off: null }}
        />
        <SourceNote kind="partner" part={partnerPart} words={{ reading: t('Partner reading'), unread: t('Partner unread'), off: null }} />
      </div>
      {blocked.length > 0 ? (
        <StateBlock
          kind="refused"
          testId="money-state"
          className="money-state"
          title={t('No matches')}
          body={t('Filters unanswerable', { names: blocked.map((name) => t(FILTER_WORD[name])).join(', ') })}
        />
      ) : shown.length === 0 && !anyReading ? (
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={narrowed ? t('No matches') : t('Nothing yet')}
          body={narrowed ? t('No matches body') : t('Nothing yet body')}
        />
      ) : (
        <table data-testid="money-table" className="money-table money-table--activity">
          <colgroup>
            <col className="money-act-col--what" />
            <col className="money-act-col--time" />
            <col className="money-act-col--amount" />
            <col className="money-act-col--status money-cell--status" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t('Activity')}</th>
              <th scope="col">{t('Date')}</th>
              <th scope="col" className="money-num">
                {t('Amount')}
              </th>
              <th scope="col" className="money-cell--status">
                {t('Status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((line) => (
              <LineRow key={line.id} line={line} t={t} hidden={hidden} zone={timeZone} test={line.source === 'venue' && status.test} />
            ))}
          </tbody>
        </table>
      )}
      {bank.status === 'ready' && bank.data.hasMore && partner.length > 0 ? (
        <div className="money-more">
          <Button variant="secondary" size={40} loading={bank.data.loadingMore} onClick={bank.data.loadMore}>
            {t('Partner more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SourceNote({
  kind,
  part,
  words,
  test = false,
}: {
  kind: SourceLine['source'];
  part: Part;
  words: { reading: string; unread: string; off: string | null };
  test?: boolean;
}) {
  const { t } = sourcesCopy.useCopy();
  const text =
    part.state === 'read' ? part.note : part.state === 'off' ? words.off : part.state === 'reading' ? words.reading : words.unread;
  if (text === null) return null;
  return (
    <p data-testid="money-source-note" data-source={kind} data-state={part.state} className="money-caption">
      {text}
      {test && part.state === 'read' ? (
        <>
          {' '}
          <Badge tone="warn">{t('TEST')}</Badge>
        </>
      ) : null}
    </p>
  );
}

function titleOf(line: SourceLine, t: T): string {
  if (line.source === 'wallet') return line.direction === 'in' ? t('Received in your wallet') : t('Sent from your wallet');
  if (line.source === 'venue') {
    if (line.detail?.kind === 'trade') return t(line.detail.side === 'buy' ? 'Bought {asset}' : 'Sold {asset}', { asset: line.asset });
    return t('Deposit to your venue account');
  }
  switch (line.kind) {
    case 'deposit':
      return t('Deposit');
    case 'withdrawal':
      return t('Withdrawal');
    case 'transfer_in':
      return t('Received');
    case 'transfer_out':
      return t('Sent');
    case 'space_move':
      return t('Moved between your accounts');
    case 'fee':
      return t('Fee');
    case 'earn':
      return t('Earn');
    default:
      return t('Other activity');
  }
}

function subOf(line: SourceLine, t: T): string | null {
  const detail = line.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case 'trade': {
      const parts = [
        t(detail.side === 'buy' ? 'Paid {amount} {asset}' : 'Got {amount} {asset}', {
          amount: exact(detail.quote.amount),
          asset: detail.quote.asset,
        }),
      ];
      if (detail.fee)
        parts.push(
          t(detail.fee.rebate ? 'Rebate {amount} {asset}' : 'Fee {amount} {asset}', {
            amount: exact(detail.fee.amount),
            asset: detail.fee.asset,
          }),
        );
      return parts.join(' · ');
    }
    case 'space':
      return t('In account {name}', { name: detail.name });
    case 'confirming':
      return null;
  }
}

function sourceLabel(line: SourceLine, t: T): string {
  if (line.source === 'wallet') return t('From wallet', { name: line.sourceName });
  if (line.source === 'venue') return t('From venue', { name: line.sourceName });
  return t('From partner', { name: line.sourceName });
}

function LineRow({
  line,
  t,
  hidden,
  zone,
  test,
}: {
  line: SourceLine;
  t: T;
  hidden: boolean;
  zone: ReturnType<typeof usePreferences>['timeZone'];
  test: boolean;
}) {
  const up = line.direction === 'in';
  const counted = line.state === 'completed';
  const sub = subOf(line, t);
  const amount = exact(line.amount);
  return (
    <tr
      data-testid="money-act"
      className="money-act"
      data-kind={line.kind}
      data-source={line.source}
      data-ref={line.ref}
      data-state={line.state}
    >
      <td>
        <div className="money-act__what">
          <span className="money-act__text">
            <span data-testid="money-act__title" className="money-act__title">
              {titleOf(line, t)}
            </span>
            {sub ? (
              <span data-testid="money-act__sub" className="money-act__sub">
                {sub}
              </span>
            ) : null}
            <span data-testid="money-act__source" className="money-act__sub" data-source={line.source}>
              {sourceLabel(line, t)}
              {test ? (
                <>
                  {' '}
                  <Badge tone="warn">{t('TEST')}</Badge>
                </>
              ) : null}
            </span>
          </span>
        </div>
      </td>
      <td data-testid="money-act__time" className="money-act__time">
        <time dateTime={line.at}>{stamp(line.at, zone)}</time>
      </td>
      <td className="money-num">
        <Amount
          value={counted ? `${up ? '+' : '−'}${amount} ${line.asset}` : `${amount} ${line.asset}`}
          hidden={hidden}
          className={counted ? (up ? 'text-up-text' : 'text-down-text') : undefined}
          data-direction={line.direction}
        />
      </td>
      <td data-testid="money-act__status" className="money-act__status money-cell--status">
        {line.state === 'completed' ? (
          <span data-testid="money-act__done" className="money-act__done">
            <Check size={14} aria-hidden="true" />
            {t('Completed')}
          </span>
        ) : line.state === 'confirming' && line.detail?.kind === 'confirming' ? (
          <span>
            {t('Confirming {count} of {required}', { count: String(line.detail.confirmations), required: String(line.detail.required) })}
          </span>
        ) : (
          <span>{line.state === 'failed' ? t('Failed') : t('Not credited')}</span>
        )}
      </td>
    </tr>
  );
}
