import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session/session';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button, DataTable } from '@intafaced/ui';
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
import { useAssetChoices } from './asset-choices';
import { isWebAddress, LinkAddress } from './LinkAddress';
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

/**
 * The address a link can be copied, opened and scanned from: the checkout address the service stored for it, else one built
 * from a token the service sent. Null when the service sent neither, or the address is not an ordinary web address. Only an
 * active link that has not expired shows it (see the call site).
 */
export function addressOf(link: { checkoutUrl?: string | null; token?: string | null }): string | null {
  if (link.checkoutUrl && isWebAddress(link.checkoutUrl)) return link.checkoutUrl;
  // The service sends a path from its public base; the browser's own origin completes it.
  if (link.checkoutUrl && link.checkoutUrl.startsWith('/')) return `${location.origin}${link.checkoutUrl}`;
  if (link.token) return `${location.origin}/pay/checkout?token=${encodeURIComponent(link.token)}`;
  return null;
}

/** Matches the mounted createLink input, with a stricter UI requirement to pair a fixed amount and its asset. */
export const createLinkInputSchema = z
  .object({
    merchantId: s.id,
    label: z.string().trim().min(1).max(120),
    profileId: s.id.optional(),
    amount: s.positiveAmount.optional(),
    currency: s.asset.optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
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
        if (linkId && !selected) return <EmptyState title={t('linkNotFound')}>{t('linkNotFoundBody')}</EmptyState>;
        const rows = links
          .filter(
            (link) =>
              (!status || linkState(link, now) === status) &&
              (!q || `${link.id} ${link.label} ${link.prefix}`.toLowerCase().includes(q.toLowerCase())),
          )
          .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
        const noWrite = pay.access('pay:write') !== null;
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
              <>
                <Facts
                  items={[
                    [t('linkId'), <span className="pp-mono pp-copy">{selected.id}</span>],
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
                    [t('uses'), selected.uses],
                    [t('maxUses'), selected.maxUses ?? t('noUseCap')],
                    [t('expiry'), selected.expiresAt ? <DateTime value={selected.expiresAt} /> : '—'],
                  ]}
                />
                <PaySection title={t('linkDetail')}>
                  <Timeline
                    label={t('linkDetail')}
                    items={[
                      { at: selected.createdAt, title: t('created') },
                      ...(selected.expiresAt && Date.parse(selected.expiresAt) <= now
                        ? [{ at: selected.expiresAt, title: t('expired') }]
                        : []),
                    ]}
                  />
                </PaySection>
                <PaySection title={t('lk_addressTitle')} description={t('lk_addressBody')}>
                  {addressOf(selected) && linkState(selected, now) === 'active' ? (
                    <LinkAddress url={addressOf(selected)!} />
                  ) : (
                    <p className="pp-callout" role="note">
                      {t('lk_addressBlocked')}
                    </p>
                  )}
                </PaySection>
                {portal && <LinkPayments portal={portal} merchantId={merchantId} linkId={selected.id} />}
                {noWrite && (
                  <p className="muted pp-note" role="note">
                    {t('linkOwnerOnly')}
                  </p>
                )}
                <div title={noWrite ? t('linkOwnerOnly') : !selected.active ? t('inactiveTip') : undefined}>
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
                        ]}
                      />
                    }
                    disabled={noWrite || !selected.active}
                    perform={async () => {
                      const result = definite(
                        await pay.mutate(
                          'merchant.deactivateLink',
                          { merchantId, linkId: selected.id },
                          z.object({ deactivated: z.boolean() }),
                          'pay:write',
                          `link-deactivate:${selected.id}`,
                        ),
                      );
                      return result.ok && !result.data.deactivated
                        ? { ok: false as const, reason: 'error' as const, code: 'portal.local', message: t('deactivateNotConfirmed') }
                        : result;
                    }}
                    onConfirmed={retry}
                  />
                </div>
              </>
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
                  <DataTable label={t('linksTitle')} headers={[t('linkLabel'), t('amount'), t('status'), t('uses'), t('expiry')]}>
                    {rows.map((link) => (
                      <tr key={link.id}>
                        <td>
                          <a className="text-link" href={`/pay/links/${encodeURIComponent(link.id)}`}>
                            {link.label}
                          </a>
                          <small className="pay-cell-note pp-mono">{link.prefix}</small>
                        </td>
                        <td>
                          {link.amount === null ? (
                            t('payerChooses')
                          ) : link.currency ? (
                            <Money value={link.amount} asset={link.currency} />
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <LinkChip value={linkState(link, now)} />
                        </td>
                        <td>
                          {link.uses}
                          {link.maxUses !== null ? ` / ${link.maxUses}` : ''}
                        </td>
                        <td>{link.expiresAt ? <DateTime value={link.expiresAt} /> : '—'}</td>
                      </tr>
                    ))}
                  </DataTable>
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
  const [form, setForm] = useState({ label: '', amount: '', currency: '', profileId: '', expiry: '', maxUses: '' });
  const [created, setCreated] = useState<z.infer<typeof s.newLinkSchema> | null>(null);
  const [sent, setSent] = useState(false);
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
    ...(form.profileId ? { profileId: form.profileId } : {}),
    ...(form.expiry ? { expiresAt: `${form.expiry}:00Z` } : {}),
    ...(form.maxUses ? { maxUses: /^[1-9]\d*$/.test(form.maxUses) ? Number(form.maxUses) : NaN } : {}),
  });
  const noWrite = pay.access('pay:write') !== null;
  useUnsavedForm(!sent && Object.values(form).some(Boolean), t('unsaved'));
  const field = (key: keyof typeof form, label: string, hint: string, required = false, type = 'text') => (
    <Field
      label={`${label}${required ? ' *' : ''}`}
      hint={hint}
      required={required}
      type={type}
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
      <div className="form-stack pp-form">
        <fieldset className="pp-group">
          <legend>{t('groupCheckout')}</legend>
          {field('label', t('linkLabel'), t('linkLabelHint'), true)}
          <div className="form-row">
            {field('amount', t('fixedAmount'), t('fixedAmountHint'))}
            <SelectField
              label={t('lk_asset')}
              value={form.currency}
              onChange={(value) => setForm({ ...form, currency: value })}
              hint={t('assetHint')}
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
        {!parsed.success && <p className="muted">{t('invalidForm')}</p>}
        <div title={noWrite ? t('linkOwnerOnly') : !parsed.success ? t('invalidForm') : undefined}>
          <PortalReview
            title={t('reviewLink')}
            description={t('reviewLinkBody')}
            variant="primary"
            disabled={noWrite || !parsed.success || sent || locked}
            review={
              <PayDetails
                values={[
                  [t('linkLabel'), form.label],
                  [t('amount'), form.amount ? `${form.amount} ${form.currency}` : t('payerChooses')],
                  [t('expiry'), form.expiry || t('serviceExpiry')],
                  [t('maxUses'), form.maxUses || t('noUseCap')],
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
                [t('linkId'), <span className="pp-copy pp-mono">{created.id}</span>],
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
