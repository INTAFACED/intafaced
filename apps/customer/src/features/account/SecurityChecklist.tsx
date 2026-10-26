import { useRef } from 'react';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { securityChecklistCopy as copy } from './security-checklist-copy';
import { factorStatus, type FactorStatus } from './security-checklist';

/**
 * The Security checklist at the top of `/uc/safe` (slice I-signin-sessions-14): each sign-in method with its status and
 * why an open one matters, and the actions that always need a second step. Those carry "Required" even with no owner
 * policy, because the floor holds whatever the setting says. No score number. `revision` goes up when a method changes
 * on this page, and the list loads again.
 */
export function SecurityChecklist({ revision = 0 }: { revision?: number } = {}) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  // A new api client for the same person (a refreshed session) reads again, as Security's own list does.
  const client = useRef({ api, version: 0 });
  if (client.current.api !== api) client.current = { api, version: client.current.version + 1 };
  // The last answer for this person stays on screen while a change on the page reloads it, so the page does not jump.
  const last = useRef<{ userId: string | null; data: FactorStatus } | null>(null);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'factorStatus', undefined, factorStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `security-checklist:${userId}:${client.current.version}:${revision}`,
  );
  if (resource.status === 'ready' && resource.data) last.current = { userId, data: resource.data };
  const shown = resource.status === 'ready' ? resource.data : last.current?.userId === userId ? last.current.data : null;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  if (resource.status === 'loading' && !shown) return <Loading />;
  const status = shown;
  if (!status) return null;
  const hasSecondStep = status.checklist.some((item) => item.key === 'second_factor' && item.done);
  return (
    <section
      data-testid="security__checklist"
      className="security__checklist security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <ul data-testid="security__rows" className="security__rows">
        {status.checklist.map((item) => {
          const more = detail(status, item.key, t);
          return (
            <li key={item.key} data-testid="security__row" className="security__row" data-done={item.done}>
              <div>
                <strong>{t(item.key)}</strong> <span className="badge">{item.done ? t('done') : t('pending')}</span>
                {more && <span className="muted"> · {more}</span>}
                {!item.done && <p className="muted">{t(`${item.key}Why`)}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      {/* With no second step on yet, the service lets the password alone change sign-in methods; say so plainly. */}
      <h3>{hasSecondStep ? t('requiredTitle') : t('requiredTitleNoFactor')}</h3>
      {!hasSecondStep && <p className="muted">{t('noFactorYet')}</p>}
      <ul data-testid="security__rows" className="security__rows">
        {status.secondStepRequired.floor.map((action) => (
          <li key={action} data-testid="security__row" className="security__row">
            <span>{t(action)}</span> <span className="badge">{t('required')}</span>
          </li>
        ))}
      </ul>
      {status.secondStepRequired.policy === null && <p className="muted">{t('policyUnset')}</p>}
    </section>
  );
}

function detail(status: FactorStatus, key: FactorStatus['checklist'][number]['key'], t: ReturnType<typeof copy.useCopy>['t']) {
  if (key === 'passkey' && status.passkeys.count > 0) return t('passkeyCount', { count: status.passkeys.count });
  if (key === 'authenticator' && status.authenticator.on && status.authenticator.label) return status.authenticator.label;
  if (key === 'recovery_codes' && status.authenticator.on) return t('codesLeft', { count: status.recoveryCodesLeft });
  return null;
}
