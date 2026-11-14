import { createContext, useContext, useState } from 'react';
import { z } from 'zod';
import {
  POINTS_OWNER_QUESTION,
  pointsProgrammeSchema,
  type PointsCatalogueItem,
  type PointsProgramme as Programme,
} from '@intafaced/contracts/campaigns-catalogue';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Loading, Page, Panel } from '../../shared/ui';
import { PromotionTabs } from './Promotions';
import { promotionsCopy } from './promotions-copy';
import { pointsProgrammeCopy } from './points-programme-copy';

/**
 * The points programme on /uc/promotion/points (CM-rewards-hub-04, J-campaigns-15 #1-#4): the wallet, members and
 * lifecycle, the expiry modes and pending points, the rewards catalogue and conversion, each in its full layout. Whether
 * INTAFACED runs a points programme whose points have value or convert to cash is an open owner question, so svc-campaigns
 * keeps no points and returns every number blank: a blank reads "Not kept" or "Not set", never a figure. Convert and
 * Redeem are real presses; svc-campaigns refuses each with `owner.decision` before reading or storing anything, and the
 * refusal names the question. After a press the page reads the programme again rather than trusting what it showed.
 */

type Refused = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof pointsProgrammeCopy.useCopy>['t'];

/** Each press's last refusal, kept above the read so it stays on screen while the programme is read again. */
const Refusals = createContext<{ of: Record<string, Refused>; set: (id: string, refused: Refused | null) => void }>({
  of: {},
  set: () => {},
});

/** /uc/promotion/points: the promotions page's points tab. */
export function PromotionPoints() {
  const { userId } = useSession();
  const { t, Copy } = promotionsCopy.useCopy();
  return (
    <div className="promotions">
      <Page title={t('title')} description={t('description')}>
        {userId ? (
          <>
            <PromotionTabs view="points" />
            <PointsProgramme />
          </>
        ) : (
          <EmptyState
            title={t('signIn')}
            action={
              <a className="text-link" href="/login?redirect=%2Fuc%2Fpromotion%2Fpoints">
                <Copy k="signIn" />
              </a>
            }
          >
            <Copy k="guest" />
          </EmptyState>
        )}
      </Page>
    </div>
  );
}

export function PointsProgramme() {
  const api = useApi();
  const { t } = pointsProgrammeCopy.useCopy();
  const programme = useResource(
    (signal) => api.query('campaigns', 'points.programme', {}, pointsProgrammeSchema, { signal }),
    'points-programme',
  );
  const r = programme.resource;
  const [refusals, setRefusals] = useState<Record<string, Refused>>({});
  const set = (id: string, refused: Refused | null) =>
    setRefusals((all) => {
      const next = { ...all };
      if (refused) next[id] = refused;
      else delete next[id];
      return next;
    });
  return (
    <Refusals.Provider value={{ of: refusals, set }}>
      <section className="points-programme" aria-label={t('title')} data-testid="points-programme" data-state={r.status}>
        <Panel title={t('title')}>
          <p className="muted">{t('intro')}</p>
          {r.status === 'loading' ? (
            <Loading label={t('loading')} />
          ) : r.status === 'failed' ? (
            <div data-testid="points-failed">
              <Failure result={r.failure} retry={programme.reload} />
            </div>
          ) : (
            <Layout data={r.data} reread={programme.reload} />
          )}
        </Panel>
      </section>
    </Refusals.Provider>
  );
}

const shown = (value: string | number | null, blank: string) => (value === null ? blank : String(value));

function Layout({ data, reread }: { data: Programme; reread: () => void }) {
  const { t } = pointsProgrammeCopy.useCopy();
  const question = data.blocker?.question ?? null;
  return (
    <>
      <div role="note" className="points-programme__blocker" data-testid="points-blocker" data-code={data.blocker?.code ?? ''}>
        {question ? (
          <>
            <strong>{t('blockerTitle')}</strong> <span>{t('blockerLead')}</span> <span data-testid="points-question">{question}</span>
          </>
        ) : (
          t('blockerNone')
        )}
      </div>

      <section aria-label={t('walletTitle')} data-testid="points-wallet">
        <h3>{t('walletTitle')}</h3>
        <dl>
          {(
            [
              ['available', t('walletAvailable'), data.wallet.available],
              ['pending', t('walletPending'), data.wallet.pending],
              ['expiring', t('walletExpiring'), data.wallet.expiring],
            ] as const
          ).map(([key, label, value]) => (
            <div key={key} data-testid={`points-wallet-${key}`}>
              <dt>{label}</dt>
              <dd lang={value === null ? undefined : 'zxx'}>{shown(value, t('notKept'))}</dd>
            </div>
          ))}
        </dl>
        {data.wallet.available === null && <p className="muted">{t('notKeptNote')}</p>}
      </section>

      <section aria-label={t('membersTitle')} data-testid="points-members">
        <h3>{t('membersTitle')}</h3>
        <dl>
          <div>
            <dt>{t('membersCount')}</dt>
            <dd data-testid="points-members-count">{shown(data.members.count, t('notKept'))}</dd>
          </div>
        </dl>
        {data.members.count === null && <p className="muted">{t('membersNote')}</p>}
      </section>

      <section aria-label={t('lifecycleTitle')} data-testid="points-lifecycle">
        <h3>{t('lifecycleTitle')}</h3>
        <ol aria-label={t('lifecycleLabel')}>
          {data.lifecycle.stages.map((stage) => (
            <li key={stage} data-stage={stage} aria-current={data.lifecycle.current === stage ? 'step' : undefined}>
              {t(`stage_${stage}`)}
            </li>
          ))}
        </ol>
        <p className="muted" data-testid="points-lifecycle-current">
          {data.lifecycle.current ? `${t('stageCurrent')}: ${t(`stage_${data.lifecycle.current}`)}` : t('lifecycleNone')}
        </p>
      </section>

      <section aria-label={t('expiryTitle')} data-testid="points-expiry">
        <h3>{t('expiryTitle')}</h3>
        <p className="muted">{t('expiryIntro')}</p>
        <dl>
          <div>
            <dt>{t('expiryCurrent')}</dt>
            <dd data-testid="points-expiry-current">{data.expiry.current ? t(`mode_${data.expiry.current}`) : t('notSet')}</dd>
          </div>
        </dl>
        <DataTable label={t('expiryModes')} headers={[t('colMode'), t('colHorizon')]}>
          {data.expiry.modes.map((m) => (
            <tr key={m.mode} data-testid="points-expiry-mode" data-mode={m.mode}>
              <td>{t(`mode_${m.mode}`)}</td>
              <td data-testid="points-expiry-horizon">
                {m.mode === 'never' ? '—' : m.horizonSeconds === null ? t('notSet') : String(m.horizonSeconds)}
              </td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section aria-label={t('pendingTitle')} data-testid="points-pending">
        <h3>{t('pendingTitle')}</h3>
        {data.pending.length === 0 ? (
          <div data-testid="points-pending-empty">
            <EmptyState title={t('pendingEmptyTitle')}>{t('pendingEmptyBody')}</EmptyState>
          </div>
        ) : (
          <DataTable label={t('pendingLabel')} headers={[t('colPoints'), t('colAvailableAt')]}>
            {data.pending.map((p) => (
              <tr key={p.id} data-testid="points-pending-row">
                <td lang="zxx">{p.points}</td>
                <td>{new Date(p.availableAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section aria-label={t('catalogueTitle')} data-testid="points-catalogue">
        <h3>{t('catalogueTitle')}</h3>
        <p className="muted">{t('catalogueIntro')}</p>
        <DataTable label={t('catalogueLabel')} headers={[t('colBenefit'), t('colPrice'), t('colStock'), t('colLimit'), t('colAction')]}>
          {data.catalogue.map((item) => (
            <CatalogueRow key={item.id} item={item} question={question} reread={reread} t={t} />
          ))}
        </DataTable>
      </section>

      <section aria-label={t('convertTitle')} data-testid="points-convert">
        <h3>{t('convertTitle')}</h3>
        <p className="muted">{t('convertIntro')}</p>
        <dl>
          <div>
            <dt>{t('convertRate')}</dt>
            <dd data-testid="points-convert-rate">
              {data.conversion.rate === null ? t('notSet') : `${data.conversion.rate} ${data.conversion.asset ?? ''}`.trim()}
            </dd>
          </div>
          <div>
            <dt>{t('convertMinimum')}</dt>
            <dd data-testid="points-convert-minimum">{shown(data.conversion.minimumPoints, t('notSet'))}</dd>
          </div>
        </dl>
        <Press
          label={t('convert')}
          testId="points-convert-refusal"
          question={question}
          reread={reread}
          send={(api) => api.mutate('campaigns', 'points.convert', {}, z.never())}
        />
      </section>
    </>
  );
}

function CatalogueRow({
  item,
  question,
  reread,
  t,
}: {
  item: Programme['catalogue'][number];
  question: string | null;
  reread: () => void;
  t: T;
}) {
  const name = t(`item_${item.id}` as `item_${PointsCatalogueItem}`);
  return (
    <tr data-testid="points-catalogue-item" data-item={item.id}>
      <td>{name}</td>
      <td data-testid="points-item-price">{shown(item.pricePoints, t('notSet'))}</td>
      <td data-testid="points-item-stock">{shown(item.stock, t('notSet'))}</td>
      <td data-testid="points-item-limit">{shown(item.perPersonLimit, t('notSet'))}</td>
      <td>
        <Press
          label={t('redeem')}
          aria={t('redeemNamed', { item: name })}
          testId={`points-redeem-refusal-${item.id}`}
          question={question}
          reread={reread}
          send={(api) => api.mutate('campaigns', 'points.redeem', { itemId: item.id }, z.never())}
        />
      </td>
    </tr>
  );
}

function Press({
  label,
  aria,
  testId,
  question,
  reread,
  send,
}: {
  label: string;
  aria?: string;
  testId: string;
  question: string | null;
  reread: () => void;
  send: (api: ReturnType<typeof useApi>) => Promise<ApiResult<never>>;
}) {
  const api = useApi();
  const { t } = pointsProgrammeCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const refusals = useContext(Refusals);
  const refused = refusals.of[testId] ?? null;
  const press = async () => {
    setBusy(true);
    const result = await send(api);
    setBusy(false);
    refusals.set(testId, result.ok ? null : result);
    // Whatever the answer, or none, the page reads what is stored again; a press is never repeated on its own.
    reread();
  };
  return (
    <>
      <Button variant="secondary" disabled={busy} aria-label={aria} onClick={() => void press()}>
        {label}
      </Button>
      {refused ? (
        refused.code === 'owner.decision' ? (
          <div role="status" className="muted" data-testid={testId} data-code={refused.code}>
            <strong>{t('refusedTitle')}</strong> <span>{question ?? POINTS_OWNER_QUESTION}</span> <span>{t('refusedNothing')}</span>{' '}
            <span lang="zxx">{t('refusedCode', { code: refused.code })}</span>
          </div>
        ) : (
          <div data-testid={testId} data-code={refused.code ?? ''}>
            <Failure result={refused} />
          </div>
        )
      ) : null}
    </>
  );
}
