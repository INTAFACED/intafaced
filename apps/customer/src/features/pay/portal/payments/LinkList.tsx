// volt-room: /pay/links
// volt-room: /pay/links/:linkId
// volt-room: portal:links
// volt-room: portal:link
import { useMemo, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { QrCode } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../session';
import { useResource, type Resource } from '../../../../shared/resource';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { useMerchantAccess } from '../access/MerchantAccess';
import {
  CopyReference,
  Details,
  Empty,
  EntityList,
  Facts,
  Gate,
  KpiStrip,
  Loading,
  Failure,
  MoneyText,
  ReadAt,
  Section,
  SelectField,
  StatusChip,
  Timeline,
  ToneChip,
} from '../volt/parts';
import { Review } from '../volt/Review';
import { RecordListRoom, type RecordListSlots } from '../volt/RecordListRoom';
import { useNow, useReadAt, useUrlParam } from '../hooks';
import { buildCsv, downloadText } from '../csv';
import { nextLimit, readLimit } from '../model';
import { DateTime } from '../ui/DateTime';
import { useServerList } from '../ui/useServerList';
import { paymentLabel } from '../presentation';
import type { PortalApi } from '../api';
import type { Payment } from '../schemas';
import { SubscriptionPriceFact } from '../catalog/PriceFact';
import { catalogCopy } from '../catalog/copy';
import { addressOf } from './checkout-address';
import { definite } from './not-available';
import { w3cCopy } from './copy';
import { afterWords, fullSnippet, linkState, settleDeactivate, type Link } from './link-model';
import { PAY_MERCHANT_DEACTIVATE_LINK, PAY_MERCHANT_GET_LINK } from '@intafaced/contracts/pay-merchant-procedures';

/**
 * `/pay/links` and `/pay/links/:linkId` on the record-list template: the business's payment links with their filters,
 * figures and export, or one link's own page. The owner alone reads them.
 */
export function LinksRoom({ portal, linkId, authority }: { portal: PortalApi; linkId?: string; authority: PayBusinessAuthority | null }) {
  const { access, can } = useMerchantAccess();
  // Until the business is known (and the person may read links), the template draws its own loading, refusal and role states.
  if (access.status !== 'ready' || !can('owner')) return <RecordListRoom need="owner">{() => ({})}</RecordListRoom>;
  return <LinksPage portal={portal} merchantId={access.merchantId} linkId={linkId} authority={authority} />;
}

function LinksPage({
  portal,
  merchantId,
  linkId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  linkId?: string;
  authority: PayBusinessAuthority | null;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const [rawLimit, setLimit] = useUrlParam('limit', '25');
  const limit = linkId ? 200 : readLimit(rawLimit);
  const query = useResource((signal) => portal.links(merchantId, limit, signal), `portal:links:${merchantId}:${limit}`);
  const loadedAt = useReadAt(query.resource.status === 'ready', query.resource);
  const slots = useLinkSlots({
    resource: query.resource,
    retry: query.reload,
    loadedAt,
    limit,
    more: () => setLimit(String(nextLimit(limit))),
    pay,
    merchantId,
    linkId,
    portal,
  });
  return <RecordListRoom need="owner">{() => slots}</RecordListRoom>;
}

type LinksViewProps = {
  resource: Resource<Link[]>;
  retry: () => void;
  loadedAt: string | null;
  limit: number;
  more: () => void;
  pay: BusinessPayApi;
  merchantId: string;
  linkId?: string;
  /** Reads the payments made with a link. Without it (a static preview) that list is left out. */
  portal?: PortalApi;
};

/** The links page, every region in one column: the same parts the room hands its template. */
export function LinksView(props: LinksViewProps) {
  const slots = useLinkSlots(props);
  return (
    <div className="lt-stack">
      {slots.tools}
      {slots.filters}
      {slots.summary}
      {slots.list}
      {slots.export}
      {slots.detail}
    </div>
  );
}

/** The regions of the links page for the record-list template: the list with its filters, or one link (`linkId`) alone. */
function useLinkSlots({ resource, retry, loadedAt, limit, more, pay, merchantId, linkId, portal }: LinksViewProps): RecordListSlots {
  const { t } = w3cCopy.useCopy();
  const [q, setQ] = useUrlParam('q', '');
  const [status, setStatus] = useUrlParam('status', '');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  const now = useNow();
  const back = (
    <a className="lt-link" href={linkId ? '/pay/links' : '/pay/merchant'}>
      ← {t(linkId ? 'backLinks' : 'lk_backHome')}
    </a>
  );
  const stale = loadedAt && now - Date.parse(loadedAt) > 300_000 && (
    <p className="lt-stale" role="status">
      {t('staleLinks')}
    </p>
  );
  const refresh = (
    <Button tone="secondary" onClick={retry}>
      {t('lk_refresh')}
    </Button>
  );
  if (linkId)
    return {
      detail: (
        <div className="lt-stack">
          {back}
          <Gate resource={resource} retry={retry}>
            {(links) => {
              const selected = links.find((link) => link.id === linkId);
              if (!selected)
                return <FetchedLinkDetail pay={pay} merchantId={merchantId} linkId={linkId} now={now} portal={portal} retry={retry} />;
              return (
                <div className="lt-stack">
                  <ReadAt at={loadedAt} />
                  {stale}
                  {refresh}
                  <LinkDetail selected={selected} now={now} pay={pay} merchantId={merchantId} portal={portal} retry={retry} />
                </div>
              );
            }}
          </Gate>
        </div>
      ),
    };
  if (resource.status !== 'ready')
    return {
      tools: back,
      list: resource.status === 'loading' ? <Loading /> : <Failure result={resource.failure} retry={retry} />,
    };
  const links = resource.data;
  const rows = links
    .filter(
      (link) =>
        (!status || linkState(link, now) === status) &&
        (!q || `${link.id} ${link.label} ${link.prefix}`.toLowerCase().includes(q.toLowerCase())),
    )
    .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
  return {
    tools: (
      <div className="lt-actions">
        {back}
        {refresh}
      </div>
    ),
    filters: (
      <div className="lt-field-row" role="search" aria-label={t('searchLinks')}>
        <Field label={t('searchLinks')} type="search" value={q} onChange={(event) => setQ(event.target.value)} />
        <SelectField
          label={t('linkStatus')}
          value={status}
          onChange={setStatus}
          options={[
            ['', t('allStatuses')],
            ...(['active', 'inactive', 'expired', 'exhausted', 'unknown'] as const).map(
              (state) => [state, t(state === 'unknown' ? 'lk_unknown' : state)] as const,
            ),
          ]}
        />
        <SelectField
          label={t('sortRecords')}
          value={sort}
          onChange={setSort}
          options={[
            ['newest', t('newest')],
            ['oldest', t('oldest')],
          ]}
        />
      </div>
    ),
    summary: (
      <div className="lt-stack">
        <ReadAt at={loadedAt} />
        {stale}
        <KpiStrip
          label={t('linksTitle')}
          tiles={[
            { label: t('loadedLinks'), period: t('linksPeriod'), value: links.length, href: `?limit=${limit}` },
            ...(['active', 'expired', 'inactive'] as const).map((state) => ({
              label: t(state),
              period: t('linksPeriod'),
              value: links.filter((link) => linkState(link, now) === state).length,
              href: `?limit=${limit}&status=${state}`,
            })),
          ]}
        />
        <p>
          {links.length === 1 ? t('linkCountOne', { shown: rows.length }) : t('linkCount', { shown: rows.length, loaded: links.length })}
        </p>
      </div>
    ),
    export:
      rows.length > 0 ? (
        <Button
          tone="secondary"
          onClick={() =>
            downloadText(
              'payment-links.csv',
              buildCsv(
                ['id', 'label', 'amount', 'asset', 'status', 'uses', 'max_uses', 'expires_at', 'created_at'],
                rows.map((link) => [
                  link.id,
                  link.label,
                  link.amount ?? '',
                  link.currency ?? '',
                  linkState(link, now),
                  link.uses,
                  link.maxUses ?? '',
                  link.expiresAt ?? '',
                  link.createdAt,
                ]),
                { generatedAt: new Date().toISOString(), asOf: loadedAt ?? '' },
              ),
            )
          }
        >
          {t('exportLinks')}
        </Button>
      ) : undefined,
    list: (
      <div className="lt-stack">
        {rows.length ? (
          <EntityList
            label={t('linksTitle')}
            rows={rows}
            rowKey={(link) => link.id}
            href={(link) => `/pay/links/${encodeURIComponent(link.id)}`}
            columns={[
              {
                header: t('linkLabel'),
                cell: (link) => (
                  <>
                    <a className="lt-link" href={`/pay/links/${encodeURIComponent(link.id)}`}>
                      {link.label}
                    </a>{' '}
                    <small data-testid="pp-mono" className="lt-hint lt-mono">
                      {link.prefix}
                    </small>
                  </>
                ),
              },
              {
                header: t('amount'),
                cell: (link) =>
                  link.amount === null ? t('payerChooses') : link.currency ? <MoneyText value={link.amount} asset={link.currency} /> : '—',
              },
              { header: t('status'), cell: (link) => <LinkChip value={linkState(link, now)} /> },
              {
                header: t('uses'),
                cell: (link) => <>{link.maxUses !== null ? t('lk_usesOf', { uses: link.uses, max: link.maxUses }) : link.uses}</>,
              },
              { header: t('expiry'), cell: (link) => (link.expiresAt ? <DateTime value={link.expiresAt} /> : '—') },
            ]}
          />
        ) : (
          <Empty title={t(links.length ? 'linkNoMatches' : 'linkEmpty')}>{t(links.length ? 'linkNoMatchesBody' : 'linkEmptyBody')}</Empty>
        )}
        {links.length >= limit && limit < 200 && (
          <div className="lt-actions">
            <Button tone="secondary" onClick={more}>
              {t('loadMoreLinks')}
            </Button>
          </div>
        )}
        {links.length >= 200 && <p className="lt-hint">{t('linkAtLimit')}</p>}
      </div>
    ),
  };
}

type LinkDetailProps = {
  selected: Link;
  now: number;
  pay: BusinessPayApi;
  merchantId: string;
  portal?: PortalApi;
  retry: () => void;
};
/** One link: its facts, its address, the payments made with it, and the owner's deactivate step. */
function LinkDetail({ selected, now, pay, merchantId, portal, retry }: LinkDetailProps) {
  const { t } = w3cCopy.useCopy();
  const noWrite = pay.access('pay:write') !== null;
  const state = linkState(selected, now);
  const address = addressOf(selected);
  return (
    <>
      <Facts
        items={[
          [
            t('linkId'),
            <span data-testid="pp-mono" className="lt-mono">
              {selected.id}
            </span>,
          ],
          [t('linkLabel'), selected.label],
          [t('status'), <LinkChip value={state} />],
          [
            t('amount'),
            selected.amount === null ? (
              t('payerChooses')
            ) : selected.currency ? (
              <MoneyText value={selected.amount} asset={selected.currency} />
            ) : (
              '—'
            ),
          ],
          ...(selected.priceId && portal
            ? [[catalogCopy.t('linkPrice'), <SubscriptionPriceFact portal={portal} priceId={selected.priceId} />] as const]
            : []),
          [t('uses'), selected.uses],
          [t('maxUses'), selected.maxUses ?? t('noUseCap')],
          [t('expiry'), selected.expiresAt ? <DateTime value={selected.expiresAt} /> : '—'],
          [
            t('lk_afterFact'),
            afterWords(
              selected.confirmationUrl
                ? { kind: 'redirect', url: selected.confirmationUrl }
                : selected.confirmationMessage
                  ? { kind: 'message', message: selected.confirmationMessage }
                  : undefined,
            ),
          ],
          ...(!selected.active
            ? [[t('lk_payerMessageFact'), selected.inactiveMessage || t('lk_payerMessageNone')] as [string, string]]
            : []),
        ]}
      />
      <Section title={t('linkDetail')}>
        <Timeline
          label={t('linkDetail')}
          items={[
            { at: selected.createdAt, title: t('created') },
            ...(selected.expiresAt && Date.parse(selected.expiresAt) <= now ? [{ at: selected.expiresAt, title: t('expired') }] : []),
            // The service does not record when a link was switched off, so the page says so rather than guess.
            ...(!selected.active ? [{ title: t('lk_deactivatedEvent') }] : []),
          ]}
        />
      </Section>
      <Section title={t('lk_addressTitle')} {...(address && state === 'active' ? { description: t('lk_addressBody') } : {})}>
        {address && state === 'active' ? (
          <ShareAddress url={address} />
        ) : (
          <p className="lt-hint" role="note">
            {t(
              !selected.active
                ? 'lk_addressDeactivated'
                : ['expired', 'exhausted'].includes(state)
                  ? 'lk_addressClosed'
                  : 'lk_addressBlocked',
            )}
          </p>
        )}
      </Section>
      {state === 'active' && address && (
        <Section title={t('lk_embedTitle')} {...(selected.embedSnippet ? { description: t('lk_embedBody') } : {})}>
          {selected.embedSnippet ? (
            <CopyReference value={fullSnippet(selected.embedSnippet)} what={t('lk_embedWhat')} />
          ) : (
            <p className="lt-muted">{t('lk_embedNone')}</p>
          )}
        </Section>
      )}
      {portal && <LinkPayments portal={portal} merchantId={merchantId} linkId={selected.id} />}
      {noWrite && (
        <p className="lt-hint" role="note">
          {t('linkOwnerOnly')}
        </p>
      )}
      {selected.active && <DeactivateLink selected={selected} pay={pay} merchantId={merchantId} noWrite={noWrite} retry={retry} />}
    </>
  );
}

/** Only ordinary web addresses are ever made clickable. */
const isWebAddress = (value: string) => /^https?:\/\//i.test(value);

/** The checkout address of a payment link, with the three things a merchant does with it: copy it, open it, scan it. */
function ShareAddress({ url }: { url: string }) {
  const { t } = w3cCopy.useCopy();
  return (
    <div className="lt-stack" data-testid="link-address">
      <CopyReference value={url} what={t('lk_addressWhat')} />
      {isWebAddress(url) && (
        <div className="lt-actions">
          <a className="lt-button lt-button-secondary" href={url} target="_blank" rel="noopener noreferrer">
            {t('lk_open')}
          </a>
        </div>
      )}
      <QrCode value={url} label={t('lk_qrLabel')} failed={t('lk_qrFailed')} size="sm" />
    </div>
  );
}

/**
 * A link that is not among the newest 200 the list loads: read it by its own id (`merchant.getLink`), so an older link
 * still opens and can still be deactivated.
 */
function FetchedLinkDetail({ pay, merchantId, linkId, now, portal, retry }: Omit<LinkDetailProps, 'selected'> & { linkId: string }) {
  const { t } = w3cCopy.useCopy();
  const query = useResource(
    (signal) => pay.queryRecord(PAY_MERCHANT_GET_LINK, { merchantId, linkId }, signal),
    `portal:link:${merchantId}:${linkId}`,
  );
  const reload = () => {
    query.reload();
    retry();
  };
  return (
    <Gate resource={query.resource} retry={query.reload}>
      {(link) =>
        link.id === linkId ? (
          <LinkDetail selected={link} now={now} pay={pay} merchantId={merchantId} portal={portal} retry={reload} />
        ) : (
          <Empty title={t('linkNotFound')}>{t('linkNotFoundBody')}</Empty>
        )
      }
    </Gate>
  );
}

/**
 * The deactivate step. If its answer is lost the device keeps the attempt (`link-deactivate:<id>`) and refuses a second
 * one until it is settled. "Check this link" reads the link: inactive means the first attempt worked; still active means
 * it did not, so the old attempt is cleared and the owner can send it again (deactivating twice does no harm).
 */
function DeactivateLink({
  selected,
  pay,
  merchantId,
  noWrite,
  retry,
}: {
  selected: Link;
  pay: BusinessPayApi;
  merchantId: string;
  noWrite: boolean;
  retry: () => void;
}) {
  const { t } = w3cCopy.useCopy();
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [payerNote, setPayerNote] = useState('');
  const lockId = `${pay.authority?.userId}:link-deactivate:${selected.id}`;
  // `pending` is this tab's own request still in flight (the button is off, nothing to check yet); `uncertain` is an
  // attempt whose answer was lost, here or in another tab, and only then is there something to check.
  const attempt = pay.authority ? pay.guard.status(lockId) : undefined;
  const held = Boolean(attempt);
  const uncertain = attempt === 'uncertain';
  async function check() {
    setBusy(true);
    setMessage('');
    try {
      const state = await settleDeactivate(pay, merchantId, selected.id);
      setMessage(
        t(state === 'failed' ? 'lk_deactivateCheckFailed' : state === 'inactive' ? 'lk_deactivateWorked' : 'lk_deactivateStillActive'),
      );
      if (state === 'inactive') retry();
    } finally {
      setBusy(false);
      refresh((n) => n + 1);
    }
  }
  return (
    <div className="lt-stack" title={noWrite ? t('linkOwnerOnly') : undefined}>
      <Field
        label={t('lk_payerMessage')}
        hint={t('lk_payerMessageHint')}
        maxLength={500}
        disabled={noWrite || held}
        value={payerNote}
        onChange={(event) => setPayerNote(event.target.value)}
      />
      <Review
        title={t('deactivateLink')}
        description={t('deactivateBody')}
        variant="sell"
        review={
          <Details
            values={[
              [t('linkId'), selected.id],
              [t('linkLabel'), selected.label],
              [t('uses'), selected.uses],
              [t('lk_payerMessageFact'), payerNote.trim() || t('lk_payerMessageNone')],
            ]}
          />
        }
        disabled={noWrite || held}
        perform={async () => {
          const result = definite(
            await pay.mutateRecord(
              PAY_MERCHANT_DEACTIVATE_LINK,
              { merchantId, linkId: selected.id, ...(payerNote.trim() ? { message: payerNote.trim() } : {}) },
              'pay:write',
              `link-deactivate:${selected.id}`,
            ),
          );
          refresh((n) => n + 1);
          return result.ok && !result.data.deactivated
            ? {
                ok: false as const,
                reason: 'error' as const,
                code: 'portal.local',
                // Already off (another tab got there first): the service keeps the first deactivation's message, if any.
                message: t(payerNote.trim() ? 'lk_payerMessageNotKept' : 'deactivateNotConfirmed'),
              }
            : result;
        }}
        onConfirmed={retry}
      />
      {uncertain && (
        <div className="lt-stack">
          <p className="lt-stale" role="status">
            {t('lk_deactivateUnresolved')}
          </p>
          <Button tone="secondary" disabled={busy || noWrite} onClick={() => void check()}>
            {t('lk_deactivateCheck')}
          </Button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

/** The payments made through one link, read from the payments list filtered by that link. */
function LinkPayments({ portal, merchantId, linkId }: { portal: PortalApi; merchantId: string; linkId: string }) {
  const { t } = w3cCopy.useCopy();
  const list = useServerList(
    (f, cursor, signal) => portal.paymentPage(merchantId, { linkId: f.linkId! }, cursor, signal),
    { linkId },
    (p: Payment) => p.id,
  );
  return (
    <Section title={t('linkPaymentsTitle')}>
      {list.state.status === 'loading' && <Loading rows={3} />}
      {list.state.status === 'failed' && <Failure result={list.state.failure} retry={list.reload} />}
      {list.state.status === 'ready' &&
        (list.state.items.length === 0 ? (
          <Empty title={t('lk_paymentsEmpty')}>{t('lk_paymentsEmptyBody')}</Empty>
        ) : (
          <>
            <EntityList
              label={t('linkPaymentsTitle')}
              rows={list.state.items}
              rowKey={(p) => p.id}
              href={(p) => `/pay/payments/${encodeURIComponent(p.id)}`}
              columns={[
                { header: t('colPayment'), cell: (p) => <strong>{paymentLabel(p)}</strong> },
                { header: t('amount'), cell: (p) => <MoneyText value={p.amount} asset={p.assetId} /> },
                { header: t('status'), cell: (p) => <StatusChip entity="payment" value={p.status} /> },
                { header: t('created'), cell: (p) => <DateTime value={p.createdAt} /> },
              ]}
            />
            {list.state.hasMore && (
              <div className="lt-actions">
                <Button tone="secondary" onClick={list.loadMore} disabled={list.state.more === 'loading'}>
                  {t('loadMoreLinkPayments')}
                </Button>
              </div>
            )}
          </>
        ))}
    </Section>
  );
}

const linkTone = { active: 'done', inactive: 'progress', expired: 'progress', exhausted: 'action', unknown: 'action' } as const;
/** A soft chip: the word carries the meaning, the colour only backs it up. */
function LinkChip({ value }: { value: ReturnType<typeof linkState> }) {
  const { t } = w3cCopy.useCopy();
  return (
    <ToneChip
      tone={linkTone[value]}
      label={t(value === 'unknown' ? 'lk_unknown' : value)}
      tip={t(value === 'unknown' ? 'lk_unknownTip' : (`${value}Tip` as 'activeTip'))}
    />
  );
}
