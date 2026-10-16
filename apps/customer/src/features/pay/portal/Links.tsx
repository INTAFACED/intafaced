import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../session/session';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field } from '../../../shared/ui';
import { PayDetails, PaySection, PayTime, ReviewedAction } from '../components';
import { validatedMutation } from '../BusinessPay';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../pay-api';
import * as s from '../schemas';
import { BackLink, ComingSoon, Facts, Gate, Kpi, KpiGrid, Money, ReadAt, SelectField, Timeline } from './components';
import { useNow, useReadAt, useUrlParam } from './hooks';
import { buildCsv, downloadText } from './csv';
import { nextLimit, readLimit } from './model';
import { useUnsavedForm } from './useUnsavedForm';
import { w3cCopy } from './w3c-copy';
import type { PortalApi } from './api';

type Link = z.infer<typeof s.linkSchema>;
export function linkState(link: Link, now: number) {
  if (!link.active) return 'inactive';
  if (link.expiresAt === null || !Number.isFinite(Date.parse(link.expiresAt))) return 'unknown';
  if (Date.parse(link.expiresAt) <= now) return 'expired';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'exhausted';
  return 'active';
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
      <BackLink href={create || linkId ? '/pay/links' : '/pay/merchant'}>{t(create || linkId ? 'backLinks' : 'backMerchant')}</BackLink>
      {create ? (
        <PaymentLinkForm pay={pay} merchantId={merchantId} />
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
}: {
  resource: Resource<Link[]>;
  retry: () => void;
  loadedAt: string | null;
  limit: number;
  more: () => void;
  pay: BusinessPayApi;
  merchantId: string;
  linkId?: string;
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
              {t('refresh')}
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
                    [t('expiry'), selected.expiresAt ? <PayTime value={selected.expiresAt} /> : '—'],
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
                <ComingSoon title={t('nextBackend')}>{t('linkHistoryGap')}</ComingSoon>
                {noWrite && <ComingSoon title={t('nextBackend')}>{t('linkAuthorityGap')}</ComingSoon>}
                <div title={noWrite ? t('linkAuthorityGap') : !selected.active ? t('inactiveTip') : undefined}>
                  <ReviewedAction
                    title={t('deactivateLink')}
                    description={t('deactivateBody')}
                    variant="danger"
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
                      const result = await pay.mutate(
                        'merchant.deactivateLink',
                        { merchantId, linkId: selected.id },
                        z.object({ deactivated: z.boolean() }),
                        'pay:write',
                        `link-deactivate:${selected.id}`,
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
                <ComingSoon title={t('nextBackend')}>{t('linksGap')}</ComingSoon>
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
                      ...(['active', 'inactive', 'expired', 'exhausted', 'unknown'] as const).map((state) => [state, t(state)] as const),
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
                <p>{t('linkCount', { shown: rows.length, loaded: links.length })}</p>
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
                        <td>{link.expiresAt ? <PayTime value={link.expiresAt} /> : '—'}</td>
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

function LinkChip({ value }: { value: ReturnType<typeof linkState> }) {
  const { t } = w3cCopy.useCopy();
  return (
    <span
      className={`pp-chip ${value === 'active' ? 'pp-chip--good' : value === 'inactive' ? '' : 'pp-chip--attention'}`}
      title={t(`${value}Tip`)}
    >
      {t(value)}
    </span>
  );
}

export function PaymentLinkForm({ pay, merchantId }: { pay: BusinessPayApi; merchantId: string }) {
  const { t } = w3cCopy.useCopy();
  const [form, setForm] = useState({ label: '', amount: '', currency: '', profileId: '', expiry: '', maxUses: '' });
  const [created, setCreated] = useState<z.infer<typeof s.newLinkSchema> | null>(null);
  const [sent, setSent] = useState(false);
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
      <ComingSoon title={t('nextBackend')}>{t('linkFormGap')}</ComingSoon>
      {noWrite && <ComingSoon title={t('nextBackend')}>{t('linkAuthorityGap')}</ComingSoon>}
      <div className="form-stack pp-form">
        <fieldset className="pp-group">
          <legend>{t('groupCheckout')}</legend>
          {field('label', t('linkLabel'), t('linkLabelHint'), true)}
          <div className="form-row">
            {field('amount', t('fixedAmount'), t('fixedAmountHint'))}
            {field('currency', t('asset'), t('assetHint'))}
          </div>
          {form.amount && !form.currency && <p className="error-text">{t('invalidAmountAsset')}</p>}
          {field('profileId', t('profile'), t('profileHint'))}
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('groupAvailability')}</legend>
          {field('expiry', t('expiry'), t('expiryHint'), false, 'datetime-local')}
          {field('maxUses', t('maxUses'), t('maxUsesHint'))}
        </fieldset>
        {!parsed.success && <p className="muted">{t('invalidForm')}</p>}
        <div title={noWrite ? t('linkAuthorityGap') : !parsed.success ? t('invalidForm') : undefined}>
          <ReviewedAction
            title={t('reviewLink')}
            description={t('reviewLinkBody')}
            variant="primary"
            disabled={noWrite || !parsed.success || sent}
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
            perform={() =>
              validatedMutation(
                pay,
                'merchant.createLink',
                parsed.success ? parsed.data : {},
                createLinkInputSchema,
                s.newLinkSchema,
                'pay:write',
                'link-create',
              )
            }
            onConfirmed={(value) => {
              setCreated(value);
              setSent(true);
            }}
          />
        </div>
        {created && (
          <PaySection title={t('publishedOnce')} description={t('publishedOnceBody')}>
            <a
              className="text-link pp-mono pp-copy"
              href={`/pay/checkout?token=${encodeURIComponent(created.token)}`}
            >{`${location.origin}/pay/checkout?token=${encodeURIComponent(created.token)}`}</a>
            <Facts
              items={[
                [t('linkId'), <span className="pp-copy pp-mono">{created.id}</span>],
                [t('expiry'), <PayTime value={created.expiresAt} />],
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
