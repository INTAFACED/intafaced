import { useRef, useState } from 'react';
import type { z } from 'zod';
import { Button } from '@intafaced/ui/lit';
import { TextField } from '@intafaced/ui/lit/templates';
import {
  AUTO_TOP_UP_GET,
  AUTO_TOP_UP_OFF,
  AUTO_TOP_UP_SET,
  AUTO_TOP_UP_SUBMIT_PERMISSION,
  type autoTopUpViewSchema,
} from '@intafaced/contracts/trade-auto-top-up-procedures';
import { useApi } from '../../session';
import { usePolled, useWallet } from '../../protocol';
import { Waiting } from '../../more';
import { preparedAnswerSchema, walletTypedData } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { AsOfLine, TestMark } from '../venue/volt/VoltVenue';
import { positionsCopy } from './positions-copy';

type View = z.output<typeof autoTopUpViewSchema>;

/**
 * Auto top-up of one isolated position's margin (J-derivatives-06 #4; svc-trade src/venue/auto-top-up.ts): the person sets
 * the margin level that starts a top-up, the amount each adds and a cap, and the first time on the venue account the
 * agent permission's own cap, which their wallet approves once. Our engine adds the amount once per fall to the level,
 * signed by the agent permission, never past either cap. Every figure is the service's and the venue's own.
 */
export function AutoTopUpPanel({ owner, symbol, venueName }: { owner: string; symbol: string; venueName: string }) {
  const { t } = positionsCopy.useCopy();
  const api = useApi();
  const wallet = useWallet();
  const read = usePolled<View>(
    (signal) => api.call(AUTO_TOP_UP_GET, { owner, symbol }, { signal }),
    `auto-top-up:${owner}:${symbol}`,
    VENUE_POLL_MS,
  );
  const view = read.data;
  const [level, setLevel] = useState<string | null>(null);
  const [each, setEach] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [permissionCap, setPermissionCap] = useState('');
  const [said, setSaid] = useState<{ tone: 'ok' | 'refused'; text: string } | null>(null);
  const busy = useRef(false);

  const asset = view?.asset ?? '';
  const setting = view?.setting ?? null;
  // The form starts from the saved terms; what the person types replaces them.
  const levelValue = level ?? setting?.triggerLevel ?? '';
  const eachValue = each ?? setting?.amountEach ?? '';
  const capValue = cap ?? setting?.cap ?? '';

  /** The wallet signs the agent permission the service asked for, and it is sent once under its key. */
  async function approve(next: NonNullable<View['next']>): Promise<View | null> {
    const typed = preparedAnswerSchema.shape.prepared.shape.typedData.safeParse(next.typedData);
    if (!typed.success) {
      setSaid({ tone: 'refused', text: t('atuWalletFailed') });
      return null;
    }
    const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(typed.data) });
    if (signed.status !== 'signed') {
      setSaid({ tone: 'refused', text: t(signed.status === 'rejected' ? 'atuWalletRejected' : 'atuWalletFailed') });
      return null;
    }
    const sent = await api.call(AUTO_TOP_UP_SUBMIT_PERMISSION, {
      owner,
      symbol,
      actionKey: next.actionKey,
      signature: { digest: next.digest, signature: signed.signature, signedBy: owner },
    });
    if (!sent.ok) {
      setSaid({ tone: 'refused', text: t('atuRefused', { detail: sent.message }) });
      return null;
    }
    return sent.data;
  }

  async function act(f: () => Promise<{ ok: true; data: View } | { ok: false; message: string }>) {
    if (busy.current) return;
    busy.current = true;
    setSaid(null);
    try {
      const answer = await f();
      if (!answer.ok) return setSaid({ tone: 'refused', text: t('atuRefused', { detail: answer.message }) });
      let now: View | null = answer.data;
      if (now.next) now = await approve(now.next);
      if (now) {
        setLevel(null);
        setEach(null);
        setCap(null);
        setPermissionCap('');
        setSaid({ tone: 'ok', text: t('atuSaved') });
      }
    } finally {
      busy.current = false;
      read.reload();
    }
  }

  const save = () =>
    act(() =>
      api.call(AUTO_TOP_UP_SET, {
        owner,
        symbol,
        triggerLevel: levelValue,
        amountEach: eachValue,
        cap: capValue,
        permissionCap: view?.permission ? null : permissionCap,
      }),
    );
  const turnOff = () => act(() => api.call(AUTO_TOP_UP_OFF, { owner, symbol }));

  const permission = view?.permission ?? null;
  const state = !setting?.on
    ? t('atuStateOff')
    : setting.stopped === 'cap'
      ? t('atuStateCap', { added: setting.added, cap: setting.cap, each: setting.amountEach })
      : setting.stopped === 'permission_cap' && permission
        ? t('atuStatePermissionCap', { used: permission.used, cap: permission.cap, each: setting.amountEach })
        : setting.armed
          ? t('atuStateWatching', { level: setting.triggerLevel })
          : t('atuStateWaiting', { level: setting.triggerLevel });

  return (
    <section className="lt-stack" aria-label={t('atuTitle', { symbol })} data-testid="auto-top-up">
      <h3>
        {t('atuTitle', { symbol })} <TestMark test={view?.venue.test ?? false} />
      </h3>
      <p className="lt-hint">{t('atuLead', { venue: view?.venue.name ?? venueName })}</p>
      {view === null && read.failure ? (
        <p className="lt-refusal" role="alert">
          {t('atuRefused', { detail: read.failure.message })}
        </p>
      ) : view === null ? (
        <Waiting label={t('atuTitle', { symbol })} />
      ) : (
        <>
          {view.position ? (
            <>
              <dl>
                <dt>{t('atuMarginNow')}</dt>
                <dd className="lt-mono" data-line="atu-margin">
                  {view.position.marginWithResult}
                </dd>
              </dl>
              <AsOfLine asOf={view.position.asOf} />
            </>
          ) : (
            <p className="lt-hint">{t('atuNoPosition', { symbol })}</p>
          )}
          <p data-line="atu-state">{state}</p>
          {setting ? (
            <dl>
              <dt>{t('atuAdded')}</dt>
              <dd className="lt-mono" data-line="atu-added">
                {setting.added}
              </dd>
              <dt>{t('atuRoom')}</dt>
              <dd className="lt-mono" data-line="atu-room">
                {setting.room}
              </dd>
            </dl>
          ) : null}
          {permission ? (
            <dl data-testid="auto-top-up-permission">
              <dt>{t('atuPermission')}</dt>
              <dd data-line="atu-permission">
                {permission.approved
                  ? t('atuPermissionApproved', { venue: view.venue.name })
                  : t('atuPermissionWaiting', { venue: view.venue.name })}
              </dd>
              <dt>{t('atuPermissionCap', { asset })}</dt>
              <dd className="lt-mono" data-line="atu-permission-cap">
                {permission.cap}
              </dd>
              <dt>{t('atuPermissionUsed')}</dt>
              <dd className="lt-mono" data-line="atu-permission-used">
                {permission.used}
              </dd>
              <dt>{t('atuPermissionRoom')}</dt>
              <dd className="lt-mono" data-line="atu-permission-room">
                {permission.room}
              </dd>
            </dl>
          ) : null}
          <TextField label={t('atuLevel', { asset })} inputMode="decimal" value={levelValue} onChange={setLevel} />
          <TextField label={t('atuEach', { asset })} inputMode="decimal" value={eachValue} onChange={setEach} />
          <TextField label={t('atuCap', { asset })} inputMode="decimal" value={capValue} onChange={setCap} />
          {permission ? null : (
            <TextField
              label={t('atuPermissionCap', { asset })}
              hint={t('atuPermissionCapHint')}
              inputMode="decimal"
              value={permissionCap}
              onChange={setPermissionCap}
            />
          )}
          <Button onClick={() => void save()}>{setting?.on ? t('atuSave') : t('atuTurnOn')}</Button>{' '}
          {permission && !permission.approved && view.next ? (
            <Button tone="secondary" onClick={() => void act(async () => ({ ok: true, data: view }))}>
              {t('atuApprove')}
            </Button>
          ) : null}{' '}
          {setting?.on ? (
            <Button tone="secondary" onClick={() => void turnOff()}>
              {t('atuTurnOff')}
            </Button>
          ) : null}
          {said?.tone === 'refused' ? (
            <p className="lt-refusal" role="alert" data-testid="auto-top-up-said">
              {said.text}
            </p>
          ) : null}
          {said?.tone === 'ok' ? (
            <p className="lt-hint" role="status" data-testid="auto-top-up-said">
              {said.text}
            </p>
          ) : null}
          <h4>{t('atuTopUpsTitle')}</h4>
          {view.topUps.length === 0 ? (
            <p className="lt-hint">{t('atuTopUpsNone')}</p>
          ) : (
            <table data-testid="auto-top-ups">
              <thead>
                <tr>
                  <th scope="col">{t('atuHKey')}</th>
                  <th scope="col">{t('atuHAmount')}</th>
                  <th scope="col">{t('atuHMarginAt')}</th>
                  <th scope="col">{t('atuHState')}</th>
                </tr>
              </thead>
              <tbody>
                {view.topUps.map((u) => (
                  <tr key={u.sequence} data-sequence={u.sequence} data-state={u.state} data-key={u.changeKey}>
                    <td data-cell="number">{t('atuNumber', { n: String(u.sequence) })}</td>
                    <td className="lt-mono" data-cell="amount">
                      {u.amount}
                    </td>
                    <td className="lt-mono" data-cell="margin-at">
                      {u.marginAt}
                    </td>
                    <td data-cell="state">
                      {u.state === 'added'
                        ? t('atuDone')
                        : u.state === 'sending'
                          ? t('atuSending')
                          : t('atuRefusedRow', { detail: u.refusal ?? '' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
