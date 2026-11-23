import { useRef, useState } from 'react';
import type { z } from 'zod';
import { Button, Field } from '@intafaced/ui/lit';
import {
  MARGIN_TOPUP_GET,
  MARGIN_TOPUP_OFF,
  MARGIN_TOPUP_SET,
  MARGIN_TOPUP_SET_PERMISSION_CAP,
  type marginTopUpViewSchema,
} from '@intafaced/contracts/trade-margin-topup-procedures';
import { ScrollTable, Waiting } from '../../more';
import { usePolled } from '../../protocol';
import { useSession } from '../../session';
import type { ApiResult } from '../../../shared/api';
import type { VenuePosition } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { useAsOfText, type ActionResult, type RunAction } from '../venue/VenueKit';
import { OutcomeLine } from '../venue/volt/VoltVenue';
import { positionsCopy } from './positions-copy';

type TopUpView = z.output<typeof marginTopUpViewSchema>;

/**
 * Auto top-up on one isolated position (J-derivatives-06 #4): the person gives the margin top-up agent permission once,
 * with its own cap, and sets the margin level that starts a top-up, what each adds and a cap. Our engine then adds that
 * amount once each time the margin level falls to the level, as one venue margin change from the person's own free
 * balance into this position's margin, never past the rule's cap or the permission's. Every figure here is the
 * service's own string: the position's from the venue, the rule's and the permission's as stored; none is worked out
 * in the browser.
 */
export function AutoTopUp({
  row,
  owner,
  run,
  onDone,
}: {
  row: { readonly venue: { readonly id: string; readonly name: string }; readonly position: VenuePosition };
  owner: string;
  run: RunAction;
  /** The margin panel's own reload, so its lines follow a permission or a rule that changed. */
  onDone?: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const { api } = useSession();
  const time = useAsOfText();
  const symbol = row.position.symbol;
  const read = usePolled<TopUpView>(
    (signal) => api.call(MARGIN_TOPUP_GET, { owner, symbol }, { signal }),
    `margin-topup:${owner}:${row.venue.id}:${symbol}`,
    VENUE_POLL_MS,
  );
  // What the person typed; null shows the stored value, so a saved rule reads back as the service holds it.
  const [typedCap, setTypedCap] = useState<string | null>(null);
  const [typedLevel, setTypedLevel] = useState<string | null>(null);
  const [typedAmount, setTypedAmount] = useState<string | null>(null);
  const [typedRuleCap, setTypedRuleCap] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const busy = useRef(false);

  const view = read.data;
  const words = { symbol, venue: row.venue.name };

  /** One call at a time; whatever it answered, the panel and the margin lines are read again. */
  async function once(act: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setProblem(null);
    setResult(null);
    try {
      await act();
    } finally {
      busy.current = false;
      read.reload();
      onDone?.();
    }
  }

  /** A refusal is shown in the service's words and nothing else happens; an answer is handed on. */
  function accepted(answer: ApiResult<TopUpView>): TopUpView | null {
    if (answer.ok) return answer.data;
    setProblem(answer.message);
    return null;
  }

  const givePermission = (capText: string) =>
    once(async () => {
      // The cap is stored first: the key is never approved without one.
      const set = accepted(await api.call(MARGIN_TOPUP_SET_PERMISSION_CAP, { owner, symbol, cap: capText }));
      if (!set) return;
      setTypedCap(null);
      if (set.permission.approved) return;
      setResult(
        await run(
          { kind: 'approve_agent', agentAddress: set.permission.agentAddress, agentName: set.permission.agentName, validUntil: null },
          { actionKey: set.permission.actionKey, venueId: row.venue.id },
        ),
      );
    });

  const setRule = (input: { level: string; amount: string; cap: string }) =>
    once(async () => {
      if (!accepted(await api.call(MARGIN_TOPUP_SET, { owner, symbol, ...input }))) return;
      setTypedLevel(null);
      setTypedAmount(null);
      setTypedRuleCap(null);
    });

  const turnOff = () =>
    once(async () => {
      accepted(await api.call(MARGIN_TOPUP_OFF, { owner, symbol }));
    });

  const title = t('topupTitle', words);
  if (!view) {
    return (
      <section className="lt-stack" aria-label={title} data-testid="position-auto-topup">
        <h4>{title}</h4>
        {read.failure ? (
          <p className="lt-refusal" role="alert" data-testid="topup-read-problem">
            {t('topupReadFailed', { detail: read.failure.message })}
          </p>
        ) : (
          <Waiting label={title} />
        )}
      </section>
    );
  }
  if (view.venue.id !== row.venue.id) {
    return (
      <section className="lt-stack" aria-label={title} data-testid="position-auto-topup">
        <h4>{title}</h4>
        <p className="lt-hint" data-line="other-venue">
          {t('topupOtherVenue', { engineVenue: view.venue.name, venue: row.venue.name })}
        </p>
      </section>
    );
  }

  const { permission, rule, position, asset } = view;
  const permitted = permission.approved && permission.cap !== null;
  const capText = typedCap ?? permission.cap ?? '';
  const level = typedLevel ?? rule?.level ?? '';
  const amount = typedAmount ?? rule?.amount ?? '';
  const ruleCap = typedRuleCap ?? rule?.cap ?? '';
  const state = (s: TopUpView['topUps'][number]) =>
    s.state === 'added'
      ? t('topupAddedState')
      : s.state === 'sending'
        ? t('topupSending')
        : t('topupRefused', { failure: s.failure ?? '' });

  return (
    <section className="lt-stack" aria-label={title} data-testid="position-auto-topup">
      <h4>{title}</h4>
      <p className="lt-hint">{t('topupLead', words)}</p>
      <dl>
        <dt>{t('topupLevelNow')}</dt>
        <dd className="lt-mono" data-line="margin-level">
          {position === null
            ? t('topupNoPosition', words)
            : position.marginLevel === null
              ? t('topupLevelNone', words)
              : t('topupPercent', { value: position.marginLevel })}
        </dd>
      </dl>
      <p className="lt-hint">{t('topupLevelHint')}</p>

      <div className="lt-stack" data-testid="topup-permission">
        <h5>{t('topupPermissionTitle')}</h5>
        <p className="lt-hint">{t('topupPermissionHint')}</p>
        <dl>
          <dt>{t('topupPermissionState')}</dt>
          <dd data-line="permission-state" data-approved={permission.approved ? 'true' : 'false'}>
            {permission.approved ? t('topupPermissionApproved', words) : t('topupPermissionNotGiven', words)}
          </dd>
          <dt>{t('topupPermissionCapNow')}</dt>
          <dd className="lt-mono" data-line="permission-cap">
            {permission.cap ?? t('topupNotSet')}
          </dd>
          <dt>{t('topupPermissionAdded')}</dt>
          <dd className="lt-mono" data-line="permission-added">
            {permission.added}
          </dd>
        </dl>
        <Field
          label={t('topupPermissionCap', { asset })}
          inputMode="decimal"
          value={capText}
          onChange={(e) => setTypedCap(e.target.value)}
        />
        <Button onClick={() => void givePermission(capText)}>{permitted ? t('topupSetPermissionCap') : t('topupGivePermission')}</Button>
      </div>

      <div className="lt-stack" data-testid="topup-rule">
        <h5>{t('topupRuleTitle')}</h5>
        {rule ? (
          <>
            <dl>
              <dt>{t('topupStatus')}</dt>
              <dd data-line="topup-status">{rule.on ? t('topupOn') : t('topupOff')}</dd>
              <dt>{t('topupLevel')}</dt>
              <dd className="lt-mono" data-line="topup-level">
                {t('topupPercent', { value: rule.level })}
              </dd>
              <dt>{t('topupAmount')}</dt>
              <dd className="lt-mono" data-line="topup-amount">
                {rule.amount}
              </dd>
              <dt>{t('topupCap')}</dt>
              <dd className="lt-mono" data-line="topup-cap">
                {rule.cap}
              </dd>
              <dt>{t('topupAdded')}</dt>
              <dd className="lt-mono" data-line="topup-added">
                {rule.added}
              </dd>
            </dl>
            {rule.on ? (
              <p role="status" data-line="topup-armed" data-armed={rule.armed ? 'true' : 'false'}>
                {rule.armed ? t('topupArmed', { level: rule.level, amount: rule.amount, asset }) : t('topupWaiting', { level: rule.level })}
              </p>
            ) : null}
            {rule.stopped ? (
              <p className="lt-refusal" role="status" data-line="topup-stopped" data-stopped={rule.stopped}>
                {rule.stopped === 'cap'
                  ? t('topupStoppedCap', { cap: rule.cap, asset })
                  : t('topupStoppedPermissionCap', { cap: permission.cap ?? t('topupNotSet'), asset })}
              </p>
            ) : null}
          </>
        ) : null}
        <Field label={t('topupLevelField')} inputMode="decimal" value={level} onChange={(e) => setTypedLevel(e.target.value)} />
        <Field
          label={t('topupAmountField', { asset })}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setTypedAmount(e.target.value)}
        />
        <Field
          label={t('topupCapField', { asset })}
          inputMode="decimal"
          value={ruleCap}
          onChange={(e) => setTypedRuleCap(e.target.value)}
        />
        <Button onClick={() => void setRule({ level, amount, cap: ruleCap })}>{rule?.on ? t('topupChange') : t('topupTurnOn')}</Button>
        {rule?.on ? (
          <>
            {' '}
            <Button tone="secondary" onClick={() => void turnOff()}>
              {t('topupTurnOff')}
            </Button>
          </>
        ) : null}
      </div>

      {problem ? (
        <p className="lt-refusal" role="alert" data-testid="topup-problem">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} venueId={row.venue.id} />

      <div className="lt-stack" data-testid="topups">
        <h5>{t('topupsTitle')}</h5>
        {view.topUps.length === 0 ? (
          <p className="lt-hint">{t('topupsNone')}</p>
        ) : (
          <ScrollTable
            label={t('topupsTitle')}
            headers={[t('hTopupNumber'), t('hTopupAmount'), t('hTopupLevel'), t('hState'), t('hTopupKey'), t('hTime')]}
          >
            {view.topUps.map((s) => (
              <tr key={s.n} data-topup={s.n}>
                <td data-cell="n">{s.n}</td>
                <td className="lt-mono" data-cell="amount">
                  {s.amount}
                </td>
                <td className="lt-mono" data-cell="level">
                  {t('topupPercent', { value: s.levelSeen })}
                </td>
                <td data-cell="state" data-state={s.state}>
                  {state(s)}
                </td>
                <td className="lt-mono" data-cell="key">
                  {s.changeKey}
                </td>
                <td data-cell="at">{time(s.at)}</td>
              </tr>
            ))}
          </ScrollTable>
        )}
      </div>
    </section>
  );
}
