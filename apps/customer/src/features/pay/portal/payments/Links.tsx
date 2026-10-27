import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session/session';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button } from '@intafaced/ui';
import { EmptyState, Field } from '../../ui-kit';
import { PayDetails, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { validatedMutation } from '../../BusinessPay';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import * as s from '../../schemas';
import { BackLink, Facts, Gate, Kpi, KpiGrid, Money, PortalFailure, PortalLoading, ReadAt, SelectField, Timeline } from '../components';
import { useNow, useReadAt, useUrlParam } from '../hooks';
import { buildCsv, downloadText } from '../csv';
import { nextLimit, readLimit } from '../model';
import { useUnsavedForm } from '../useUnsavedForm';
import { w3cCopy } from './copy';
import type { PortalApi } from '../api';
import { EntityList } from '../ui/EntityList';
import { DateTime } from '../ui/DateTime';
import { StatusChip, ToneChip } from '../ui/StatusChip';
import { useServerList } from '../ui/useServerList';
import { paymentLabel } from '../presentation';
import type { Payment } from '../schemas';
import type { PricedProduct } from '@intafaced/contracts/merchant-catalog';
import { LinkPricePicker } from '../catalog/LinkPrice';
import { SubscriptionPriceFact } from '../catalog/SubscriptionPrice';
import { catalogCopy } from '../catalog/copy';
import { priceWords } from '../catalog/Prices';
import { useAssetChoices } from './asset-choices';
import { addressOf } from './checkout-address';
import { LinkAddress } from './LinkAddress';
import { CopyReference } from '../ui/CopyReference';
import { definite } from './not-available';
import { linkRowSchema } from './schemas';

type Link = z.infer<typeof linkRowSchema>;
export function linkState(link: Link, now: number) {
  if (!link.active) return 'inactive';
  if (link.expiresAt === null || !Number.isFinite(Date.parse(link.expiresAt))) return 'unknown';
  if (Date.parse(link.expiresAt) <= now) return 'expired';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'exhausted';
  return 'active';
}

export { addressOf };

/** What the customer sees after paying, in words. */
function afterWords(confirmation: { kind: 'message'; message: string } | { kind: 'redirect'; url: string } | undefined): string {
  if (!confirmation) return w3cCopy.t('lk_afterNone');
  return confirmation.kind === 'message'
    ? `${w3cCopy.t('lk_afterMessage')}: “${confirmation.message.trim()}”`
    : `${w3cCopy.t('lk_afterRedirect')}: ${confirmation.url.trim()}`;
}

/**
 * The button code a website can use. The service writes the checkout as a path from its public base (it invents no host),
 * so a path is completed with this site's own address: a button on the business's website must carry the full address.
 */
export function fullSnippet(snippet: string, origin = globalThis.location?.origin ?? ''): string {
  return snippet.replace(/href="\/(?!\/)/, `href="${origin}/`);
}

/**
 * An after-payment page the service will take: it parses as an address, is https, and names a host (the same test as
 * svc-pay's `parseLinkConfirmation`).
 */
export function isHttpsPage(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.href.startsWith('https://');
  } catch {
    return false;
  }
}

/**
 * A `datetime-local` value ("2026-10-17T18:30") is the merchant's own clock. Convert it to the exact moment (an ISO time in
 * UTC) the service stores. An unreadable value is returned as typed, so the form's own check refuses it.
 */
export function expiryIso(local: string): string {
  const at = new Date(local);
  return Number.isFinite(at.getTime()) ? at.toISOString() : local;
}

/** Matches the mounted createLink input, with a stricter UI requirement to pair a fixed amount and its asset. */
export const createLinkInputSchema = z
  .object({
    merchantId: s.id,
    label: z.string().trim().min(1).max(120),
    profileId: s.id.optional(),
    amount: s.positiveAmount.optional(),
    currency: s.asset.optional(),
    priceId: s.id.optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    /** After payment: a message, or the business's own https page. The service checks both again. */
    confirmation: z
      .union([
        z.object({ kind: z.literal('message'), message: z.string().trim().min(1).max(500) }).strict(),
        z
          .object({
            kind: z.literal('redirect'),
            url: z.string().trim().max(2048).refine(isHttpsPage),
          })
          .strict(),
      ])
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.amount && !value.currency) context.addIssue({ code: 'custom', path: ['currency'], message: 'asset' });
  });

export function Links({
  portal,
  merchantId,
  authority,
  create = false,
  linkId,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
  create?: boolean;
  linkId?: string;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const [rawLimit, setLimit] = useUrlParam('limit', '25');
  const limit = linkId ? 200 : readLimit(rawLimit);
  const query = useResource((signal) => portal.links(merchantId, limit, signal), `portal:links:${merchantId}:${limit}`);
  const loadedAt = useReadAt(query.resource.status === 'ready', query.resource);
  const { t } = w3cCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href={create || linkId ? '/pay/links' : '/pay/merchant'}>{t(create || linkId ? 'backLinks' : 'lk_backHome')}</BackLink>
      {create ? (
        <PaymentLinkForm pay={pay} merchantId={merchantId} portal={portal} />
      ) : (
        <LinksView
          resource={query.resource}
          retry={query.reload}
          loadedAt={loadedAt}
          limit={limit}
          more={() => setLimit(String(nextLimit(limit)))}
          pay={pay}
          merchantId={merchantId}
          linkId={linkId}
          portal={portal}
        />
      )}
    </div>
  );
}

export function LinksView({
  resource,
  retry,
  loadedAt,
  limit,
  more,
  pay,
  merchantId,
  linkId,
  portal,
}: {
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
}) {
  const { t } = w3cCopy.useCopy();
  const [q, setQ] = useUrlParam('q', '');
  const [status, setStatus] = useUrlParam('status', '');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  const now = useNow();
  return (
    <Gate resource={resource} retry={retry}>
      {(links) => {
        const selected = linkId ? links.find((link) => link.id === linkId) : null;
        if (linkId && !selected)
          return (
            <div className="stack">
              <FetchedLinkDetail pay={pay} merchantId={merchantId} linkId={linkId} now={now} portal={portal} retry={retry} />
            </div>
          );
        const rows = links
          .filter(
            (link) =>
              (!status || linkState(link, now) === status) &&
              (!q || `${link.id} ${link.label} ${link.prefix}`.toLowerCase().includes(q.toLowerCase())),
          )
          .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
        return (
          <div className="stack">
            <ReadAt at={loadedAt} />
            {loadedAt && now - Date.parse(loadedAt) > 300_000 && (
              <p className="pp-callout" role="status">
                {t('staleLinks')}
              </p>
            )}
            <Button variant="secondary" onClick={retry}>
              {t('lk_refresh')}
            </Button>
            {selected ? (
              <LinkDetail selected={selected} now={now} pay={pay} merchantId={merchantId} portal={portal} retry={retry} />
            ) : (
              <>
                <KpiGrid label={t('linksTitle')}>
                  <Kpi label={t('loadedLinks')} period={t('linksPeriod')} value={links.length} href={`?limit=${limit}`} />
                  {(['active', 'expired', 'inactive'] as const).map((state) => (
                    <Kpi
                      key={state}
                      label={t(state)}
                      period={t('linksPeriod')}
                      value={links.filter((link) => linkState(link, now) === state).length}
                      href={`?limit=${limit}&status=${state}`}
                    />
                  ))}
                </KpiGrid>
                <div className="pp-filter-row">
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
                <p>
                  {links.length === 1
                    ? t('linkCountOne', { shown: rows.length })
                    : t('linkCount', { shown: rows.length, loaded: links.length })}
                </p>
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
                            <a className="text-link" href={`/pay/links/${encodeURIComponent(link.id)}`}>
                              {link.label}
                            </a>
                            <small data-testid="pp-mono" className="pay-cell-note pp-mono">
                              {link.prefix}
                            </small>
                          </>
                        ),
                      },
                      {
                        header: t('amount'),
                        cell: (link) =>
                          link.amount === null ? (
                            t('payerChooses')
                          ) : link.currency ? (
                            <Money value={link.amount} asset={link.currency} />
                          ) : (
                            '—'
                          ),
                      },
                      { header: t('status'), cell: (link) => <LinkChip value={linkState(link, now)} /> },
                      {
                        header: t('uses'),
                        cell: (link) => <>{link.maxUses !== null ? t('lk_usesOf', { uses: link.uses, max: link.maxUses }) : link.uses}</>,
                      },
                      { header: t('expiry'), cell: (link) => (link.expiresAt ? <DateTime value={link.expiresAt} /> : '—') },
                    ]}
                    card={(link) => ({
                      title: link.label,
                      time: link.expiresAt ? (
                        <>
                          {t('expiry')} <DateTime value={link.expiresAt} />
                        </>
                      ) : undefined,
                      amount:
                        link.amount === null ? (
                          t('payerChooses')
                        ) : link.currency ? (
                          <Money value={link.amount} asset={link.currency} />
                        ) : undefined,
                      status: <LinkChip value={linkState(link, now)} />,
                    })}
                  />
                ) : (
                  <EmptyState title={t(links.length ? 'linkNoMatches' : 'linkEmpty')}>
                    {t(links.length ? 'linkNoMatchesBody' : 'linkEmptyBody')}
                  </EmptyState>
                )}
                <div className="pp-actions">
                  {links.length >= limit && limit < 200 && (
                    <Button variant="secondary" onClick={more}>
                      {t('loadMoreLinks')}
                    </Button>
                  )}
                  {rows.length > 0 && (
                    <Button
                      variant="secondary"
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
                  )}
                </div>
                {links.length >= 200 && <p className="pp-callout">{t('linkAtLimit')}</p>}
              </>
            )}
          </div>
        );
      }}
    </Gate>
  );
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
  return (
    <>
      <Facts
        items={[
          [
            t('linkId'),
            <span data-testid="pp-mono" className="pp-mono pp-copy">
              {selected.id}
            </span>,
          ],
          [t('linkLabel'), selected.label],
          [t('status'), <LinkChip value={linkState(selected, now)} />],
          [
            t('amount'),
            selected.amount === null ? (
              t('payerChooses')
            ) : selected.currency ? (
              <Money value={selected.amount} asset={selected.currency} />
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
      <PaySection title={t('linkDetail')}>
        <Timeline
          label={t('linkDetail')}
          items={[
            { at: selected.createdAt, title: t('created') },
            ...(selected.expiresAt && Date.parse(selected.expiresAt) <= now ? [{ at: selected.expiresAt, title: t('expired') }] : []),
            // The service does not record when a link was switched off, so the page says so rather than guess.
            ...(!selected.active ? [{ title: t('lk_deactivatedEvent') }] : []),
          ]}
        />
      </PaySection>
      <PaySection
        title={t('lk_addressTitle')}
        {...(addressOf(selected) && linkState(selected, now) === 'active' ? { description: t('lk_addressBody') } : {})}
      >
        {addressOf(selected) && linkState(selected, now) === 'active' ? (
          <LinkAddress url={addressOf(selected)!} />
        ) : (
          <p className="pp-callout" role="note">
            {t(
              !selected.active
                ? 'lk_addressDeactivated'
                : ['expired', 'exhausted'].includes(linkState(selected, now))
                  ? 'lk_addressClosed'
                  : 'lk_addressBlocked',
            )}
          </p>
        )}
      </PaySection>
      {linkState(selected, now) === 'active' && addressOf(selected) && (
        <PaySection title={t('lk_embedTitle')} {...(selected.embedSnippet ? { description: t('lk_embedBody') } : {})}>
          {selected.embedSnippet ? (
            <CopyReference value={fullSnippet(selected.embedSnippet)} what={t('lk_embedWhat')} />
          ) : (
            <p className="muted">{t('lk_embedNone')}</p>
          )}
        </PaySection>
      )}
      {portal && <LinkPayments portal={portal} merchantId={merchantId} linkId={selected.id} />}
      {noWrite && (
        <p className="muted pp-note" role="note">
          {t('linkOwnerOnly')}
        </p>
      )}
      {selected.active && <DeactivateLink selected={selected} pay={pay} merchantId={merchantId} noWrite={noWrite} retry={retry} />}
    </>
  );
}

/**
 * A link that is not among the newest 200 the list loads: read it by its own id (`merchant.getLink`), so an older link
 * still opens and can still be deactivated.
 */
function FetchedLinkDetail({ pay, merchantId, linkId, now, portal, retry }: Omit<LinkDetailProps, 'selected'> & { linkId: string }) {
  const { t } = w3cCopy.useCopy();
  const query = useResource(
    (signal) => pay.query('merchant.getLink', { merchantId, linkId }, linkRowSchema, signal),
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
          <EmptyState title={t('linkNotFound')}>{t('linkNotFoundBody')}</EmptyState>
        )
      }
    </Gate>
  );
}

/**
 * Settle a deactivate whose answer was lost, from the link's own state. The link is read first (a failed read changes
 * nothing). Then the held attempt is cleared: `inactive` means the first request went through; `active` means it did not,
 * and the owner may send it again (deactivating twice does no harm).
 */
export async function settleDeactivate(pay: BusinessPayApi, merchantId: string, linkId: string): Promise<'inactive' | 'active' | 'failed'> {
  const lockId = `${pay.authority?.userId}:link-deactivate:${linkId}`;
  const original = pay.guard.original(lockId);
  if (!original) return 'failed';
  // A read of an outcome that may already exist, so it is not wrapped in definite().
  const read = await pay.query('merchant.getLink', { merchantId, linkId }, linkRowSchema);
  if (!read.ok || read.data.id !== linkId) return 'failed';
  if (!(await pay.guard.resolve(lockId, original.raw))) return 'failed';
  return read.data.active ? 'active' : 'inactive';
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
    <div title={noWrite ? t('linkOwnerOnly') : undefined}>
      <Field
        label={t('lk_payerMessage')}
        hint={t('lk_payerMessageHint')}
        maxLength={500}
        disabled={noWrite || held}
        value={payerNote}
        onChange={(event) => setPayerNote(event.target.value)}
      />
      <PortalReview
        title={t('deactivateLink')}
        description={t('deactivateBody')}
        variant="sell"
        review={
          <PayDetails
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
            await pay.mutate(
              'merchant.deactivateLink',
              { merchantId, linkId: selected.id, ...(payerNote.trim() ? { message: payerNote.trim() } : {}) },
              z.object({ deactivated: z.boolean() }),
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
        <div className="stack">
          <p className="pp-callout" role="status">
            {t('lk_deactivateUnresolved')}
          </p>
          <Button variant="secondary" disabled={busy || noWrite} onClick={() => void check()}>
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
    <PaySection title={t('linkPaymentsTitle')}>
      {list.state.status === 'loading' && <PortalLoading rows={3} />}
      {list.state.status === 'failed' && <PortalFailure result={list.state.failure} retry={list.reload} />}
      {list.state.status === 'ready' &&
        (list.state.items.length === 0 ? (
          <EmptyState title={t('lk_paymentsEmpty')}>{t('lk_paymentsEmptyBody')}</EmptyState>
        ) : (
          <>
            <EntityList
              label={t('linkPaymentsTitle')}
              rows={list.state.items}
              rowKey={(p) => p.id}
              href={(p) => `/pay/payments/${encodeURIComponent(p.id)}`}
              columns={[
                { header: t('colPayment'), cell: (p) => <strong>{paymentLabel(p)}</strong> },
                { header: t('amount'), cell: (p) => <Money value={p.amount} asset={p.assetId} /> },
                { header: t('status'), cell: (p) => <StatusChip entity="payment" value={p.status} /> },
                { header: t('created'), cell: (p) => <DateTime value={p.createdAt} /> },
              ]}
              card={(p) => ({
                title: paymentLabel(p),
                time: <DateTime value={p.createdAt} />,
                amount: <Money value={p.amount} asset={p.assetId} />,
                status: <StatusChip entity="payment" value={p.status} />,
              })}
            />
            {list.state.hasMore && (
              <Button variant="secondary" onClick={list.loadMore} disabled={list.state.more === 'loading'}>
                {t('loadMoreLinkPayments')}
              </Button>
            )}
          </>
        ))}
    </PaySection>
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
/**
 * Shown when a create request was sent but its answer was lost. One button sends the very same request again: the service
 * recognises it, so it returns the link it already made instead of a second one.
 */
function LinkRecovery({
  pay,
  original,
  onFinished,
  onSettled,
}: {
  pay: BusinessPayApi;
  original: () => z.infer<typeof createLinkInputSchema> | null;
  onFinished: (link: z.infer<typeof s.newLinkSchema>) => void;
  onSettled: () => void;
}) {
  const { t } = w3cCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="stack">
      <p className="pp-callout" role="status">
        {t('lk_unresolved')}
      </p>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          const body = original();
          if (!body) {
            setMessage(t('lk_unresolvedNeedsForm'));
            return;
          }
          setBusy(true);
          try {
            const result = definite(
              await validatedMutation(pay, 'merchant.createLink', body, createLinkInputSchema, s.newLinkSchema, 'pay:write', 'link-create'),
            );
            if (result.ok) onFinished(result.data);
            else setMessage(result.reason === 'uncertain' || result.reason === 'aborted' ? t('lk_stillUnresolved') : result.message);
            onSettled();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('lk_checkOriginal')}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
export function PaymentLinkForm({ pay, merchantId, portal }: { pay: BusinessPayApi; merchantId: string; portal?: PortalApi }) {
  const { t } = w3cCopy.useCopy();
  const [form, setForm] = useState({
    label: '',
    amount: '',
    currency: '',
    priceId: '',
    profileId: '',
    expiry: '',
    maxUses: '',
    afterKind: '',
    afterMessage: '',
    afterUrl: '',
  });
  // The catalogue price picked, as the picker read it: its product's name and price words for the review.
  const [priced, setPriced] = useState<PricedProduct | null>(null);
  const [created, setCreated] = useState<z.infer<typeof s.newLinkSchema> | null>(null);
  const [sent, setSent] = useState(false);
  // Bumped when a lost reply is recovered, so the stale "outcome not confirmed" notice goes with it.
  const [recovered, setRecovered] = useState(0);
  // The details of the request in flight, so "check and finish" can send exactly the same one again.
  const original = useRef<z.infer<typeof createLinkInputSchema> | null>(null);
  const [, refreshLock] = useState(0);
  const lockId = `${pay.authority?.userId}:link-create`;
  const locked = Boolean(pay.authority && pay.guard.status(lockId));
  const assets = useAssetChoices(portal, merchantId, form.currency);
  const parsed = createLinkInputSchema.safeParse({
    merchantId,
    label: form.label,
    ...(form.amount ? { amount: form.amount } : {}),
    ...(form.currency ? { currency: form.currency } : {}),
    ...(form.priceId ? { priceId: form.priceId } : {}),
    ...(form.profileId ? { profileId: form.profileId } : {}),
    ...(form.expiry ? { expiresAt: expiryIso(form.expiry) } : {}),
    ...(form.maxUses ? { maxUses: /^[1-9]\d*$/.test(form.maxUses) ? Number(form.maxUses) : NaN } : {}),
    ...(form.afterKind === 'message' ? { confirmation: { kind: 'message', message: form.afterMessage } } : {}),
    ...(form.afterKind === 'redirect' ? { confirmation: { kind: 'redirect', url: form.afterUrl } } : {}),
  });
  const afterProblem =
    form.afterKind === 'message' && !form.afterMessage.trim()
      ? t('lk_afterMessageBlank')
      : form.afterKind === 'redirect' && !form.afterUrl.trim()
        ? t('lk_afterUrlBlank')
        : form.afterKind === 'redirect' && !isHttpsPage(form.afterUrl.trim())
          ? t('lk_afterUrlNotHttps')
          : undefined;
  const noWrite = pay.access('pay:write') !== null;
  useUnsavedForm(!sent && Object.values(form).some(Boolean), t('unsaved'));
  const fromPrice = Boolean(form.priceId);
  const field = (key: keyof typeof form, label: string, hint: string, required = false, type = 'text', disabled = false) => (
    <Field
      label={`${label}${required ? ' *' : ''}`}
      hint={hint}
      required={required}
      type={type}
      disabled={disabled}
      value={form[key]}
      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      error={
        form[key] && !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === (key === 'expiry' ? 'expiresAt' : key))
          ? t('invalidLink')
          : undefined
      }
    />
  );
  return (
    <PaySection title={t('linkNew')}>
      {noWrite && (
        <p className="muted pp-note" role="note">
          {t('linkOwnerOnly')}
        </p>
      )}
      <div data-testid="form-stack" className="form-stack pp-form">
        <fieldset className="pp-group">
          <legend>{t('groupCheckout')}</legend>
          {portal && (
            <LinkPricePicker
              portal={portal}
              value={form.priceId}
              disabled={sent}
              onChange={(choice) => {
                // The label follows the product while it is the one a price filled in; a label the owner typed stays.
                const filled = !form.label || form.label === priced?.product.name;
                setPriced(choice);
                setForm(
                  choice
                    ? {
                        ...form,
                        priceId: choice.price.id,
                        label: filled ? choice.product.name : form.label,
                        amount: choice.price.amount ?? '',
                        currency: choice.price.assetId,
                      }
                    : { ...form, priceId: '', label: filled ? '' : form.label, amount: '', currency: '' },
                );
              }}
            />
          )}
          {field('label', t('linkLabel'), t('linkLabelHint'), true)}
          <div className="form-row">
            {field('amount', t('fixedAmount'), fromPrice ? catalogCopy.t('linkPriceSets') : t('fixedAmountHint'), false, 'text', fromPrice)}
            <SelectField
              label={t('lk_asset')}
              value={form.currency}
              onChange={(value) => setForm({ ...form, currency: value })}
              hint={fromPrice ? catalogCopy.t('linkPriceSets') : t('assetHint')}
              disabled={fromPrice}
              options={[['', t('lk_noAsset')], ...assets.map((a) => [a, a] as const)]}
            />
          </div>
          {form.amount && !form.currency && <p className="error-text">{t('invalidAmountAsset')}</p>}
          {field('profileId', t('lk_profile'), t('profileHint'))}
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('groupAvailability')}</legend>
          {field('expiry', t('expiry'), t('expiryHint'), false, 'datetime-local')}
          {field('maxUses', t('maxUses'), t('maxUsesHint'))}
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('lk_groupAfter')}</legend>
          <SelectField
            label={t('lk_afterKind')}
            hint={t('lk_afterKindHint')}
            value={form.afterKind}
            // A new choice starts empty: text written for another choice is not kept to come back later.
            onChange={(value) => setForm({ ...form, afterKind: value, afterMessage: '', afterUrl: '' })}
            options={[
              ['', t('lk_afterNone')],
              ['message', t('lk_afterMessage')],
              ['redirect', t('lk_afterRedirect')],
            ]}
          />
          {form.afterKind === 'message' && (
            <Field
              label={`${t('lk_afterMessageLabel')} *`}
              hint={t('lk_afterMessageHint')}
              maxLength={500}
              value={form.afterMessage}
              onChange={(event) => setForm({ ...form, afterMessage: event.target.value })}
              error={afterProblem}
            />
          )}
          {form.afterKind === 'redirect' && (
            <Field
              label={`${t('lk_afterUrlLabel')} *`}
              hint={t('lk_afterUrlHint')}
              type="url"
              inputMode="url"
              maxLength={2048}
              value={form.afterUrl}
              onChange={(event) => setForm({ ...form, afterUrl: event.target.value })}
              error={afterProblem}
            />
          )}
        </fieldset>
        {!parsed.success && <p className="muted">{t('invalidForm')}</p>}
        <div title={noWrite ? t('linkOwnerOnly') : !parsed.success ? t('invalidForm') : undefined}>
          <PortalReview
            key={recovered}
            title={t('reviewLink')}
            description={t('reviewLinkBody')}
            variant="primary"
            disabled={noWrite || !parsed.success || sent || locked}
            review={
              <PayDetails
                values={[
                  ...(priced
                    ? [
                        [
                          catalogCopy.t('linkPrice'),
                          catalogCopy.t('linkPriceOption', { product: priced.product.name, price: priceWords(priced.price) }),
                        ] as [string, string],
                      ]
                    : []),
                  [t('linkLabel'), form.label],
                  [t('amount'), form.amount ? `${form.amount} ${form.currency}` : t('payerChooses')],
                  [t('expiry'), parsed.success && parsed.data.expiresAt ? <DateTime value={parsed.data.expiresAt} /> : t('serviceExpiry')],
                  [t('maxUses'), form.maxUses || t('noUseCap')],
                  [t('lk_afterFact'), afterWords(parsed.success ? parsed.data.confirmation : undefined)],
                ]}
              />
            }
            perform={async () => {
              if (parsed.success) original.current = parsed.data;
              const result = definite(
                await validatedMutation(
                  pay,
                  'merchant.createLink',
                  parsed.success ? parsed.data : {},
                  createLinkInputSchema,
                  s.newLinkSchema,
                  'pay:write',
                  'link-create',
                ),
              );
              refreshLock((n) => n + 1);
              return result;
            }}
            onConfirmed={(value) => {
              setCreated(value);
              setSent(true);
            }}
          />
        </div>
        {locked && !created && (
          <LinkRecovery
            pay={pay}
            original={() => original.current ?? (parsed.success ? parsed.data : null)}
            onFinished={(value) => {
              setCreated(value);
              setSent(true);
              setRecovered((n) => n + 1);
              refreshLock((n) => n + 1);
            }}
            onSettled={() => refreshLock((n) => n + 1)}
          />
        )}
        {created && (
          <PaySection title={t('publishedOnce')} description={t('publishedOnceBody')}>
            <LinkAddress url={addressOf(created) ?? ''} />
            <Facts
              items={[
                [
                  t('linkId'),
                  <span data-testid="pp-mono" className="pp-copy pp-mono">
                    {created.id}
                  </span>,
                ],
                [t('expiry'), <DateTime value={created.expiresAt} />],
                [t('maxUses'), created.maxUses ?? t('noUseCap')],
              ]}
            />
            <Button variant="secondary" onClick={() => setCreated(null)}>
              {t('hideUrl')}
            </Button>
          </PaySection>
        )}
      </div>
    </PaySection>
  );
}
