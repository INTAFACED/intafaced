import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { devicesCopy as copy } from './devices-copy';
import { byFamily, deviceName, deviceList, familyEnded, othersEnded } from './devices-api';

const LIMIT = 100;

/**
 * Devices in Security (slice I-signin-sessions-05): one row per sign-in with browser, country and last activity, sign out one
 * device, or all the others at once. Signing out is not a security-weakening change, so there is no confirmation code; "all
 * others" asks once. The device you are on is never signed out here.
 */
export function Devices({ onChanged }: { onChanged?: () => void }) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'listSessions', { userId, limit: LIMIT }, deviceList, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `devices:${userId}`,
  );

  async function run<T>(call: () => Promise<ApiResult<T>>, message: (data: T) => string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const answer = await call();
      if (!mounted.current) return;
      if (!answer.ok) return setFailure(answer);
      setAsking(false);
      setNote(message(answer.data));
      reload();
      onChanged?.();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  if (!resource.data) return null;
  const devices = byFamily(resource.data.sessions);
  const others = devices.filter((device) => !device.isCurrent).length;
  return (
    <section data-testid="security__card" className="security__devices security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {devices.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul data-testid="security__rows" className="security__rows">
          {devices.map((device) => {
            const name = deviceName(device) ?? t('unknownDevice');
            return (
              <li key={device.familyId} data-testid="security__row" className="security__row">
                <div>
                  <strong>{name}</strong>{' '}
                  {device.isCurrent && (
                    <span data-testid="security__ref" className="security__ref">
                      {t('thisDevice')}
                    </span>
                  )}
                  <span className="muted">
                    {' · '}
                    {t('lastActive', { time: stamp(device.lastUsedAt, timeZone) })}
                    {' · '}
                    {t('signedIn', { time: stamp(device.createdAt, timeZone) })}
                    {device.country ? ` · ${t('country', { country: device.country })}` : ''}
                  </span>
                </div>
                {!device.isCurrent && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={t('signOutLabel', { device: name })}
                    onClick={() =>
                      void run(
                        () => api.mutate('identity', 'revokeSessionFamily', { familyId: device.familyId }, familyEnded),
                        (data) => (data.revoked ? t('endedOne') : t('endedNone')),
                      )
                    }
                  >
                    {t('signOut')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {devices.length >= LIMIT && <p className="muted">{t('window', { limit: LIMIT })}</p>}
      <div className="actions">
        {asking ? (
          <>
            <p>{t('confirmOthers')}</p>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.mutate('identity', 'revokeOtherSessions', {}, othersEnded),
                  (data) => (data.revokedFamilies > 0 ? t('endedOthers', { count: data.revokedFamilies }) : t('endedNoOthers')),
                )
              }
            >
              {busy ? t('working') : t('confirm')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              {t('cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={busy || others === 0} onClick={() => setAsking(true)}>
              {t('signOutOthers')}
            </Button>
            <Button variant="ghost" onClick={reload}>
              {t('refresh')}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
