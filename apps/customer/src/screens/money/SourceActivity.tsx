import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useApi, useSession } from '../../features/session/session';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { createExplorerApi } from '../../features/protocol/explorer/explorer-api';
import { createVenueAccountApi } from '../../features/protocol/venue-wallet/venue-account-api';
import { venueConvertApi } from '../../features/trade/venue-convert-api';
import { WalletBar, readAllVenueOrders, useAsOfText, useOwner, useVenueApi } from '../../features/trade/venue/VenueKit';
import type { VenueUp } from '../../features/trade/venue-api';
import { usePreferences } from '../../shared/preferences';
import { Amount, Button, StateBlock, Tag } from '@intafaced/ui/lit';
import { coinHref, fmtAmount, useActivity } from './deps';
import { stamp } from './time';
import type { ActivityFilters } from './activity-filter';
import {
  keepLine,
  fillParts,
  oneList,
  orderLines,
  partnerLines,
  typeOf,
  type FillPartKind,
  unanswerable,
  venueLines,
  walletLines,
  type SourceKind,
  type SourceLine,
} from './activity-sources';
import { sourcesCopy } from './activity-sources-copy';
import { CopiedFees } from './CopiedFees';

type T = ReturnType<typeof sourcesCopy.useCopy>['t'];

/** A figure exactly as its source reports it, to every place it has: a source's fee of 0.000000175 is never shown rounded. */
const exact = (value: string) => fmtAmount(value, { places: 18 });

const FILTER_WORD = {
  note: 'filter note',
  account: 'filter account',
  year: 'filter year',
  address: 'filter address',
} as const;

/** The kit's colour for an amount, by the way the money went. */
const AMOUNT_TONE = { in: 'lt-up', out: 'lt-down' } as const;

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
  source = null,
  includeOrders = true,
  recent,
}: {
  status: VenueUp;
  filters: ActivityFilters;
  asset: string | null;
  hidden: boolean;
  /** One source's lines only (J-portfolio-01 #6: the records behind one figure), or every source's. */
  source?: SourceKind | null;
  /** Group fills by order and include resting (Set aside) and cancelled orders (J-portfolio-03 #3). */
  includeOrders?: boolean;
  /** Only the newest this many lines, with no lede, notes or filters (Assets' recent activity, owner's pick A). */
  recent?: number;
}) {
  const chainId = status.chainId ?? APP_CHAIN_ID;
  return (
    <WalletProvider chainId={chainId} scope="activity">
      <Sources
        status={status}
        chainId={chainId}
        filters={filters}
        asset={asset}
        hidden={hidden}
        source={source}
        includeOrders={includeOrders}
        recent={recent}
      />
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
  source,
  includeOrders,
  recent,
}: {
  status: VenueUp;
  chainId: number;
  filters: ActivityFilters;
  asset: string | null;
  hidden: boolean;
  source: SourceKind | null;
  includeOrders: boolean;
  recent?: number;
}) {
  const { t } = sourcesCopy.useCopy();
  const { timeZone } = usePreferences();
  const asOfText = useAsOfText();
  const owner = useOwner();
  const transport = useApi();
  const { api, userId } = useSession();
  const explorer = useMemo(() => createExplorerApi(transport), [transport]);
  const venueAccount = useMemo(() => createVenueAccountApi(api), [api]);
  const converts = useMemo(() => venueConvertApi(api), [api]);
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
      const [fills, deposits, conversions, orders] = await Promise.all([
        venue.fills(owner, ALL_FILLS_SINCE, signal),
        venueAccount.deposits(owner, signal),
        converts.history(owner, signal),
        includeOrders ? readAllVenueOrders(venue, owner, signal) : Promise.resolve({ ok: true as const, data: [] }),
      ]);
      if (!fills.ok) return fills;
      // A venue that publishes no deposit list still has its fills: the list says the deposits aren't offered.
      if (!deposits.ok && !/not_offered/.test(`${deposits.code ?? ''} ${deposits.message}`)) return deposits;
      // A deployment with no venue Convert wired has no conversions: its fills are trades. Any other failure is a failure.
      if (!conversions.ok && !/venue_convert_unwired/.test(`${conversions.code ?? ''} ${conversions.message}`)) return conversions;
      if (!orders.ok) return orders;
      return {
        ok: true as const,
        data: {
          fills: fills.data.value,
          deposits: deposits.ok ? deposits.data.value : [],
          conversions: conversions.ok ? conversions.data.conversions : [],
          orders: orders.data,
          asOf: fills.data.asOf,
        },
      };
    },
    `activity:venue:${owner ?? 'none'}:${includeOrders ? 'orders' : 'records'}`,
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
        lines: venueLines(read.fills, read.deposits, venueName, read.conversions, read.orders, { includeOrders }),
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
  const parts = { wallet: walletPart, venue: venuePart, partner: partnerPart } as const;
  const asked = source ? [parts[source]] : [walletPart, venuePart, partnerPart];
  const all = oneList(
    asked.flatMap((part) => (part.state === 'read' ? part.lines : [])),
    filters.sort,
  );
  const shown = all.filter((line) => keepLine(line, filters, timeZone, asset, titleOf(line, t)));
  const narrowed = asset !== null || filters.q.trim() !== '' || filters.dir !== 'all' || filters.from !== '' || filters.to !== '';
  const anyReading = asked.some((part) => part.state === 'reading');

  if (recent !== undefined) {
    const newest = shown.slice(0, recent);
    if (newest.length === 0) return <p className="lt-hint">{anyReading ? t('Venue reading') : t('Nothing yet body')}</p>;
    return (
      <div className="lt-table-scroll">
        <table data-testid="assets-recent-table" className="lt-table">
          <thead>
            <tr>
              <th scope="col">{t('Activity')}</th>
              <th scope="col">{t('Date')}</th>
              <th scope="col" className="lt-end">
                {t('Amount')}
              </th>
              <th scope="col">{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {newest.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                group={orderLines(all, line)}
                t={t}
                hidden={hidden}
                zone={timeZone}
                test={line.source === 'venue' && status.test}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div data-testid="activity-by-source" data-user={userId ?? ''} className="lt-stack">
      <p className="lt-muted">{t('Lede')}</p>
      <WalletBar />
      <div className="lt-stack lt-stack-tight">
        {!source || source === 'wallet' ? (
          <SourceNote
            kind="wallet"
            part={walletPart}
            words={{ reading: t('Wallet reading'), unread: t('Wallet unread'), off: t('Wallet not connected') }}
          />
        ) : null}
        {!source || source === 'venue' ? (
          <SourceNote
            kind="venue"
            part={venuePart}
            test={status.test}
            words={{ reading: t('Venue reading'), unread: t('Venue unread', { name: venueName }), off: null }}
          />
        ) : null}
        {!source || source === 'partner' ? (
          <SourceNote kind="partner" part={partnerPart} words={{ reading: t('Partner reading'), unread: t('Partner unread'), off: null }} />
        ) : null}
      </div>
      {blocked.length > 0 ? (
        <StateBlock
          kind="refused"
          testId="money-state"
          title={t('No matches')}
          body={t('Filters unanswerable', { names: blocked.map((name) => t(FILTER_WORD[name])).join(', ') })}
        />
      ) : shown.length === 0 && !anyReading ? (
        <StateBlock
          kind="empty"
          testId="money-state"
          title={narrowed ? t('No matches') : t('Nothing yet')}
          body={narrowed ? t('No matches body') : t('Nothing yet body')}
        />
      ) : (
        <div className="lt-table-scroll">
          <table data-testid="money-table" className="lt-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="lt-nowrap">{t('Activity')}</span>
                </th>
                <th scope="col">
                  <span className="lt-nowrap">{t('Date')}</span>
                </th>
                <th scope="col" className="lt-end">
                  {t('Amount')}
                </th>
                <th scope="col">
                  <span className="lt-nowrap">{t('Status')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((line) => (
                <LineRow
                  key={line.id}
                  line={line}
                  group={orderLines(all, line)}
                  t={t}
                  hidden={hidden}
                  zone={timeZone}
                  test={line.source === 'venue' && status.test}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!source ? <CopiedFees /> : null}
      {bank.status === 'ready' && bank.data.hasMore && partner.length > 0 ? (
        <div data-testid="money-more" className="lt-row">
          <Button tone="secondary" busy={bank.data.loadingMore} onClick={bank.data.loadMore}>
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
    <p data-testid="money-source-note" data-source={kind} data-state={part.state} className="lt-muted">
      {text}
      {test && part.state === 'read' ? (
        <>
          {' '}
          <Tag tone="warn">{t('TEST')}</Tag>
        </>
      ) : null}
    </p>
  );
}

function titleOf(line: SourceLine, t: T): string {
  if (line.source === 'wallet') return line.direction === 'in' ? t('Received in your wallet') : t('Sent from your wallet');
  if (line.source === 'venue') {
    if (line.kind === 'order_hold') return t('Set aside for an order');
    if (line.kind === 'order_cancelled') return t('Order cancelled · nothing spent');
    if (line.detail?.kind === 'trade' && line.detail.convert)
      return t('Converted {from} to {to}', { from: line.detail.convert.from, to: line.detail.convert.to });
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
      const parts: string[] = [];
      if (detail.fills && detail.fills.length > 1) parts.push(t('{count} fills', { count: String(detail.fills.length) }));
      parts.push(
        t(detail.side === 'buy' ? 'Paid {amount} {asset}' : 'Got {amount} {asset}', {
          amount: exact(detail.quote.amount),
          asset: detail.quote.asset,
        }),
      );
      if (detail.fee)
        parts.push(
          t(detail.fee.rebate ? 'Rebate {amount} {asset}' : 'Fee {amount} {asset}', {
            amount: exact(detail.fee.amount),
            asset: detail.fee.asset,
          }),
        );
      return parts.join(' · ');
    }
    case 'order':
      return t(detail.side === 'buy' ? 'Order buy {amount} {base} at {price} {quote}' : 'Order sell {amount} {base} at {price} {quote}', {
        amount: exact(detail.orderAmount),
        base: detail.base,
        price: exact(detail.price),
        quote: detail.quote,
      });
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
  group,
  t,
  hidden,
  zone,
  test,
}: {
  line: SourceLine;
  /** The venue trade lines of the same order as this one (this one included), for its opened group. */
  group: readonly SourceLine[];
  t: T;
  hidden: boolean;
  zone: ReturnType<typeof usePreferences>['timeZone'];
  test: boolean;
}) {
  const up = line.direction === 'in';
  const counted = line.state === 'completed';
  const holding = line.state === 'set_aside';
  const sub = subOf(line, t);
  const amount = exact(line.amount);
  const [open, setOpen] = useState(false);
  const fill = line.source === 'venue' && line.detail?.kind === 'trade' ? line.detail : null;
  const orderId = line.detail?.kind === 'trade' || line.detail?.kind === 'order' ? (line.detail.order ?? undefined) : undefined;
  const partsId = `money-act-parts-${line.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <>
      <tr
        data-testid="money-act"
        data-kind={line.kind}
        data-type={typeOf(line.kind)}
        data-source={line.source}
        data-ref={line.ref}
        data-order={orderId}
        data-state={line.state}
      >
        <td data-label={t('Activity')}>
          <div className="lt-row lt-row-nowrap">
            <span className="lt-stack lt-stack-tight">
              {fill ? (
                <span className="lt-row">
                  <Button
                    tone="quiet"
                    size="sm"
                    data-testid="money-act__title"
                    aria-expanded={open}
                    aria-controls={partsId}
                    onClick={() => setOpen((was) => !was)}
                  >
                    {titleOf(line, t)}
                  </Button>
                </span>
              ) : (
                <span data-testid="money-act__title" className="lt-strong">
                  {titleOf(line, t)}
                </span>
              )}
              {sub ? (
                <span data-testid="money-act__sub" className="lt-hint">
                  {sub}
                </span>
              ) : null}
              <span data-testid="money-act__source" className="lt-hint" data-source={line.source}>
                {sourceLabel(line, t)}
                {test ? (
                  <>
                    {' '}
                    <Tag tone="warn">{t('TEST')}</Tag>
                  </>
                ) : null}
              </span>
              {/* The source's own reference (J-cex-spot-07 #6): a transaction hash, a fill id, an order id, a deposit or a partner move id. */}
              <span data-testid="money-act__ref" className="lt-hint lt-wrap">
                {t('Source reference {ref}', { ref: line.ref })}
              </span>
            </span>
          </div>
        </td>
        <td data-testid="money-act__time" data-label={t('Date')} className="lt-nowrap">
          <time className="lt-nowrap" dateTime={line.at}>
            {stamp(line.at, zone)}
          </time>
        </td>
        <td data-testid="money-act__amount" data-label={t('Amount')} className="lt-end">
          <Amount
            value={counted || holding ? `${up ? '+' : '−'}${amount} ${line.asset}` : `${amount} ${line.asset}`}
            hidden={hidden}
            className={counted ? AMOUNT_TONE[line.direction] : undefined}
            data-direction={line.direction}
          />
        </td>
        <td data-testid="money-act__status" data-label={t('Status')}>
          {line.state === 'completed' ? (
            <span data-testid="money-act__done" className="lt-row lt-row-nowrap lt-nowrap">
              <Check size={14} aria-hidden="true" />
              {t('Completed')}
            </span>
          ) : line.state === 'set_aside' ? (
            <span data-testid="money-act__hold" className="lt-muted lt-nowrap">
              {t('Set aside')}
            </span>
          ) : line.state === 'cancelled' ? (
            <span>{t('Cancelled')}</span>
          ) : line.state === 'confirming' && line.detail?.kind === 'confirming' ? (
            <span>
              {t('Confirming {count} of {required}', { count: String(line.detail.confirmations), required: String(line.detail.required) })}
            </span>
          ) : (
            <span>{line.state === 'failed' ? t('Failed') : t('Not credited')}</span>
          )}
        </td>
      </tr>
      {fill && open ? <FillParts id={partsId} line={line} group={group} t={t} hidden={hidden} /> : null}
    </>
  );
}

function partWord(part: FillPartKind, fromHold: boolean, t: T): string {
  if (fromHold) return part === 'paid' ? t('Part paid from hold') : t('Part sold from hold');
  switch (part) {
    case 'received':
      return t('Part received');
    case 'sold':
      return t('Part sold');
    case 'paid':
      return t('Part paid');
    case 'got':
      return t('Part got');
    case 'fee':
      return t('Part fee');
    case 'rebate':
      return t('Part rebate');
    case 'held':
      return t('Part held');
    case 'released':
      return t('Part released');
  }
}
const OPEN = new Set(['open', 'partially_filled']);

/**
 * An opened venue fill (J-portfolio-03 #4 on the launch model): its order's parts as one group under the venue's own
 * references (fillParts): each fill's legs and fee, and what the venue held for an order it kept on its book and released
 * when it was cancelled. The order is read from the venue by its client id while the group is open, so a cancel shows.
 * From a purchase, a link to the coin bought.
 */
function FillParts({ id, line, group, t, hidden }: { id: string; line: SourceLine; group: readonly SourceLine[]; t: T; hidden: boolean }) {
  const venue = useVenueApi();
  const owner = useOwner();
  const order = line.detail?.kind === 'trade' ? line.detail.order : null;
  const read = usePolled(
    async (signal) => (owner && order ? venue.orderByClientId(owner, order, signal) : null),
    `activity:order:${owner ?? 'none'}:${order ?? 'none'}`,
    READ_EVERY_MS,
  );
  const record = read.data?.value ?? null;
  const parts = fillParts(group, record);
  const bought = line.detail?.kind === 'trade' && line.detail.side === 'buy';
  const multiFill = line.detail?.kind === 'trade' && (line.detail.fills?.length ?? 1) > 1;
  return (
    <tr data-testid="money-act__parts-row">
      <td colSpan={4}>
        <section id={id} data-testid="money-act__parts" aria-label={t('Parts of this order')} className="lt-stack">
          <h3 className="lt-heading">{t('Parts of this order')}</h3>
          {!multiFill ? (
            <p className="lt-hint" data-label="fill-reference">
              {t('Fill reference')} <code className="lt-mono">{line.ref}</code>
            </p>
          ) : null}
          {order ? (
            <p className="lt-hint" data-label="order-reference">
              {t('Order reference')} <code className="lt-mono">{order}</code>
            </p>
          ) : null}
          {record && OPEN.has(record.status) ? (
            <p className="lt-hint" data-label="still-held">
              {t('Still held', { amount: exact(record.locked), asset: record.lockedAsset })}
            </p>
          ) : null}
          <table className="lt-table">
            <thead>
              <tr>
                <th scope="col">{t('Part')}</th>
                <th scope="col">{t('Source reference')}</th>
                <th scope="col" className="lt-end">
                  {t('Amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {parts.map((part, index) => (
                <tr
                  key={`${part.part}:${part.fill ?? 'order'}:${index}`}
                  data-testid="money-act__part"
                  data-part={part.part}
                  data-from-hold={part.fromHold ? 'yes' : undefined}
                >
                  <td data-label={t('Part')}>{partWord(part.part, part.fromHold, t)}</td>
                  <td data-label={t('Source reference')}>
                    <code className="lt-mono">{part.fill ?? order ?? ''}</code>
                  </td>
                  <td data-label={t('Amount')} className="lt-end">
                    <Amount
                      value={`${part.up ? '+' : '−'}${exact(part.amount)} ${part.asset}`}
                      hidden={hidden}
                      className={part.up ? AMOUNT_TONE.in : AMOUNT_TONE.out}
                      data-direction={part.up ? 'in' : 'out'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bought ? (
            <a className="lt-button lt-button-secondary" href={coinHref(line.asset, 'simple')}>
              {t('See {asset} history', { asset: line.asset })}
            </a>
          ) : null}
        </section>
      </td>
    </tr>
  );
}
