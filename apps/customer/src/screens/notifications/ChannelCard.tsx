import { useId, useState } from 'react';
import { useSession } from '../../features/session/session';
import { Button, Switch } from './deps';
import { centreCopy } from './centre-copy';
import { registerTarget, removeTarget, verifyTarget, type OutOfAppChannel } from './notify-api';
import { PushDevice } from './PushDevice';
import {
  addressAction,
  addressProblem,
  canToggleMute,
  channelState,
  isSixDigits,
  registerNote,
  verifyNote,
  type AddressProblem,
  type OutOfApp,
  type RegisterNote,
  type VerifyNote,
} from './prefs';
import type { ChannelView } from './use-centre';

const TITLE = { email: 'channelEmail', push: 'channelPush', sms: 'channelSms' } as const;
const STATE = {
  always: 'inboxState',
  on: 'stateOn',
  muted: 'stateMuted',
  platformOff: 'statePlatformOff',
  noTarget: 'stateNoTarget',
  unverified: 'stateUnverified',
} as const;

type Mode = 'idle' | 'edit' | 'verify' | 'remove';
type Note = RegisterNote | VerifyNote | 'saveFailed' | 'actionFailed' | 'removed' | 'notRemoved';
type Problem = AddressProblem | 'invalidCode';

/**
 * One way of reaching the person outside the app: what state it is in and why, the pause switch, and the address steps
 * (add or change, enter the code, remove). Anything the platform cannot do yet is switched off with the reason beside it.
 */
export function ChannelCard({
  channel,
  view,
  onMute,
  onChanged,
}: {
  channel: OutOfApp;
  view: ChannelView;
  onMute: (channel: OutOfAppChannel, muted: boolean) => Promise<boolean>;
  onChanged: () => void;
}) {
  const copy = centreCopy.useCopy();
  const { api } = useSession();
  const id = useId();
  const state = channelState(channel, view.facts);
  const action = addressAction(channel, view.facts);
  const [mode, setMode] = useState<Mode>(view.facts.target && !view.facts.target.verified ? 'verify' : 'idle');
  const [address, setAddress] = useState(''),
    [code, setCode] = useState(''),
    [problem, setProblem] = useState<Problem | null>(null),
    [note, setNote] = useState<Note | null>(null),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const toggleable = canToggleMute(view.facts);
  const addressError = problem === 'invalidEmail' || problem === 'invalidSms' ? problem : null;
  const hasTarget = view.facts.target !== null;
  const platformOff = !view.facts.ready;
  const stateText = channel === 'push' && state === 'noTarget' ? copy.t('stateNoDevice') : copy.t(STATE[state as keyof typeof STATE]);
  const channelWord = copy.t(TITLE[channel]);

  async function guard(run: () => Promise<Note | null>) {
    setBusy(true);
    setNote(null);
    setProblem(null);
    try {
      const outcome = await run();
      if (outcome) setNote(outcome);
    } finally {
      setBusy(false);
    }
  }

  const startEdit = () => {
    setAddress(channel === 'email' || channel === 'sms' ? (view.address ?? '') : '');
    setMode('edit');
    setProblem(null);
  };

  return (
    <li data-testid="nf-channelcard" className="nf-channelcard" data-channel={channel}>
      <div className="nf-channelcard__head">
        <span className="nf-text">
          <span data-testid="nf-title" className="nf-title">
            {channelWord}
          </span>
          <span data-testid="nf-body" className="nf-body nf-body--wrap" id={`${id}-state`}>
            {stateText}
          </span>
        </span>
        <span data-testid="nf-channel__state" className="nf-channel__state" aria-live="polite">
          {saved ? copy.t('saved') : ''}
        </span>
        <Switch
          aria-label={copy.t('switchLabel', { channel: channelWord })}
          aria-describedby={!toggleable ? `${id}-why` : undefined}
          checked={view.facts.muted === null ? false : !view.facts.muted}
          disabled={!toggleable || busy}
          onCheckedChange={(on) => {
            setSaved(false);
            void guard(async () => {
              const ok = await onMute(channel, !on);
              setSaved(ok);
              return ok ? null : 'saveFailed';
            });
          }}
        />
      </div>
      {!toggleable && (
        <p className="nf-why" id={`${id}-why`}>
          {copy.t(platformOff ? 'switchOffPlatform' : 'switchOffNoPref')}
        </p>
      )}

      {channel === 'push' ? (
        <div className="nf-address">
          <p className="nf-why">
            {hasTarget ? copy.t('pushDevice') : copy.t('pushWhy')}
            {hasTarget && (
              <>
                {' '}
                <Button variant="ghost" size={28} disabled={busy} onClick={() => setMode('remove')}>
                  {copy.t('removeAddress')}
                </Button>
              </>
            )}
          </p>
          <PushDevice
            onSent={() => {
              setProblem(null);
              setMode('verify');
            }}
            onChanged={onChanged}
          />
        </div>
      ) : (
        <div className="nf-address">
          {hasTarget && (
            <p className="nf-address__line">
              <span className="nf-muted">{copy.t('addressOnFile')}</span> <span lang="zxx">{view.address}</span>{' '}
              <span className={`nf-pill${view.verifiedAt ? ' nf-pill--ok' : ''}`}>
                {copy.t(view.verifiedAt ? 'confirmed' : 'notConfirmed')}
              </span>
            </p>
          )}
          <div className="nf-address__actions">
            <Button
              variant="secondary"
              size={32}
              disabled={platformOff || busy}
              aria-describedby={platformOff ? `${id}-offadd` : undefined}
              onClick={startEdit}
            >
              {copy.t(hasTarget ? 'changeAddress' : 'addAddress')}
            </Button>
            {action === 'verify' && (
              <Button
                variant="secondary"
                size={32}
                disabled={busy}
                onClick={() => {
                  setProblem(null);
                  setMode('verify');
                }}
              >
                {copy.t('confirmAddress')}
              </Button>
            )}
            {hasTarget && (
              <Button variant="ghost" size={32} disabled={busy} onClick={() => setMode('remove')}>
                {copy.t('removeAddress')}
              </Button>
            )}
          </div>
          {platformOff && (
            <p className="nf-why" id={`${id}-offadd`}>
              {copy.t('addOffPlatform')}
            </p>
          )}
        </div>
      )}

      {mode === 'edit' && channel !== 'push' && (
        <form
          className="nf-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const bad = addressProblem(channel, address);
            if (bad) return setProblem(bad);
            void guard(async () => {
              const result = await registerTarget(api, channel, address.trim(), 'en');
              if (!result.ok) return 'actionFailed';
              setMode(result.data.status === 'sent' ? 'verify' : 'idle');
              setAddress('');
              onChanged();
              return registerNote(result.data.status);
            });
          }}
        >
          <label className="nf-field">
            <span>{copy.t(channel === 'email' ? 'addressEmailLabel' : 'addressSmsLabel')}</span>
            <input
              type={channel === 'email' ? 'email' : 'tel'}
              value={address}
              maxLength={channel === 'email' ? 320 : 16}
              autoComplete={channel === 'email' ? 'email' : 'tel'}
              disabled={busy}
              aria-invalid={addressError !== null}
              aria-describedby={`${id}-addr-help`}
              onChange={(event) => {
                setAddress(event.target.value);
                setProblem(null);
              }}
            />
            <small id={`${id}-addr-help`} className={addressError ? 'nf-error' : 'nf-muted'}>
              {addressError ? copy.t(addressError) : channel === 'sms' ? copy.t('addressSmsHint') : copy.t('replaceWarning')}
            </small>
          </label>
          {channel === 'sms' && <p className="nf-muted">{copy.t('replaceWarning')}</p>}
          <div className="nf-address__actions">
            <Button type="submit" size={32} disabled={busy || platformOff}>
              {copy.t('sendCode')}
            </Button>
            <Button variant="ghost" size={32} disabled={busy} onClick={() => setMode('idle')}>
              {copy.t('cancel')}
            </Button>
          </div>
        </form>
      )}

      {mode === 'verify' && hasTarget && !view.verifiedAt && (
        <form
          className="nf-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!isSixDigits(code)) return setProblem('invalidCode');
            void guard(async () => {
              const result = await verifyTarget(api, channel, code.trim());
              setCode('');
              if (!result.ok) return 'actionFailed';
              if (result.data.verified) setMode('idle');
              onChanged();
              return verifyNote(result.data);
            });
          }}
        >
          <label className="nf-field">
            <span>{copy.t('codeLabel')}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy}
              aria-invalid={problem === 'invalidCode'}
              aria-describedby={`${id}-code-help`}
              onChange={(event) => {
                setCode(event.target.value);
                setProblem(null);
              }}
            />
            <small id={`${id}-code-help`} className={problem === 'invalidCode' ? 'nf-error' : 'nf-muted'}>
              {problem === 'invalidCode' ? copy.t('invalidCode') : copy.t('codeHint')}
            </small>
          </label>
          <div className="nf-address__actions">
            <Button type="submit" size={32} disabled={busy}>
              {copy.t('confirmCode')}
            </Button>
            <Button variant="ghost" size={32} disabled={busy} onClick={() => setMode('idle')}>
              {copy.t('cancel')}
            </Button>
          </div>
        </form>
      )}

      {mode === 'remove' && hasTarget && (
        <div className="nf-form" role="group" aria-label={copy.t('removeSure')}>
          <p>{copy.t('removeSure')}</p>
          <div className="nf-address__actions">
            <Button
              variant="secondary"
              size={32}
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  const result = await removeTarget(api, channel);
                  setMode('idle');
                  if (!result.ok) return 'actionFailed';
                  onChanged();
                  return result.data.removed ? 'removed' : 'notRemoved';
                })
              }
            >
              {copy.t('removeYes')}
            </Button>
            <Button variant="ghost" size={32} disabled={busy} onClick={() => setMode('idle')}>
              {copy.t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {note && (
        <p className="nf-note" role="status">
          {copy.t(note)}
        </p>
      )}
    </li>
  );
}
