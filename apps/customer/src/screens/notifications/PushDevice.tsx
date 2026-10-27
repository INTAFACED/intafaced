import { useState } from 'react';
import { useSession } from '../../features/session/session';
import { Button } from './deps';
import { centreCopy } from './centre-copy';
import { pushKey, registerTarget } from './notify-api';
import { askPermission, deviceAddress, readPermission, type DevicePermission, type PushHost } from './push-device';
import { registerNote, type RegisterNote } from './prefs';
import { ServiceOffNotice, type NotConnectedCode } from '../../shared/service-off';

type Step =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'denied' }
  | { kind: 'dismissed' }
  | { kind: 'noGateway' }
  | { kind: 'keyFailed' }
  | { kind: 'subscribeFailed' }
  | { kind: 'sent'; note: RegisterNote };

const browser = (): PushHost => (typeof window === 'undefined' ? { navigator: {} } : (window as unknown as PushHost));
/** The allowlisted not-connected code for the push delivery gateway. */
const NOT_CONNECTED: NotConnectedCode = 'vendor.push';

/**
 * "Allow notifications on this device" (HM-notifications-02). The browser is asked only when the person presses the
 * button, never on load. Denied says what is lost and how to change it. Allowed with push delivery configured makes this
 * device's subscription and registers it as the push address (the existing code step then confirms it); allowed without
 * it shows the permission state and the `vendor.push` notice, and registers nothing.
 */
export function PushDevice({ onSent, onChanged }: { onSent: () => void; onChanged: () => void }) {
  const copy = centreCopy.useCopy();
  const { api } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [permission, setPermission] = useState<DevicePermission | null>(null);
  const unsupported = readPermission(browser()) === 'unsupported';

  async function allow() {
    setStep({ kind: 'working' });
    try {
      setStep(await run());
    } catch {
      // A browser or network call that throws leaves nothing half done on this screen: say so and allow another press.
      setStep({ kind: 'subscribeFailed' });
    }
  }

  async function run(): Promise<Step> {
    const answer = await askPermission(browser());
    setPermission(answer);
    if (answer === 'denied') return { kind: 'denied' };
    if (answer !== 'granted') return { kind: 'dismissed' };
    const key = await pushKey(api);
    if (!key.ok) return { kind: 'keyFailed' };
    if (key.data.publicKey === null) return { kind: 'noGateway' };
    const address = await deviceAddress(browser(), key.data.publicKey);
    const result = await registerTarget(api, 'push', address, 'en');
    // A lost reply may still have stored the row: re-read what is stored rather than register again.
    onChanged();
    if (!result.ok) return { kind: 'sent', note: 'sendFailed' };
    if (result.data.status === 'sent') onSent();
    return { kind: 'sent', note: registerNote(result.data.status) };
  }

  if (unsupported) return <p className="nf-why">{copy.t('pushUnsupported')}</p>;
  return (
    <div className="nf-push" data-permission={permission ?? undefined}>
      <Button variant="secondary" size={32} disabled={step.kind === 'working'} onClick={() => void allow()}>
        {copy.t('pushAllow')}
      </Button>
      {permission && (
        <p data-testid="nf-push__state" className="nf-push__state" role="status">
          {copy.t(
            permission === 'granted'
              ? step.kind === 'sent' && step.note === 'codeSent'
                ? 'pushStateAllowed'
                : 'pushStateAllowedNotRegistered'
              : permission === 'denied'
                ? 'pushStateDenied'
                : 'pushStateAsk',
          )}
        </p>
      )}
      {step.kind === 'denied' && <p className="nf-why">{copy.t('pushDeniedHow')}</p>}
      {step.kind === 'dismissed' && <p className="nf-why">{copy.t('pushDismissed')}</p>}
      {step.kind === 'noGateway' && (
        <ServiceOffNotice code={NOT_CONNECTED} action={copy.t('pushRegisterAction')} className="nf-why nf-push__off" />
      )}
      {step.kind === 'keyFailed' && <p className="nf-note">{copy.t('actionFailed')}</p>}
      {step.kind === 'subscribeFailed' && <p className="nf-note">{copy.t('pushSubscribeFailed')}</p>}
      {step.kind === 'sent' && (
        <p className="nf-note" role="status">
          {copy.t(step.note === 'codeSent' ? 'pushCodeSent' : step.note)}
        </p>
      )}
    </div>
  );
}
