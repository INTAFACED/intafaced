import { accountOperatorEntitlementSchema } from '@intafaced/contracts/account-controls';
import { z } from 'zod';
import { useApi, useSession } from '../features/session/session';
import { authoredRefusal } from '../shared/api';
import { contractProcedure, readContract } from '../shared/contract-call';
import { useResource } from '../shared/resource';
import { Button, EmptyState, Page } from '../shared/ui';
import { appCopy } from './app-copy';

/**
 * The address of the separate founder console for `path`, from the build's `VITE_TEAM_URL`, or undefined when it is not
 * set or is not a safe address (https, no sign-in details, no query or fragment; plain http only for a local dev server).
 */
export function teamConsoleHref(path: string, configured: string | undefined, dev = false): string | undefined {
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    const local = dev && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash)
      return undefined;
    return new URL(path.replace(/^\//, ''), `${url.href.replace(/\/$/, '')}/`).href;
  } catch {
    return undefined;
  }
}

/** Identity's own founder entitlement for the signed-in account. It decides only what this page offers, never access. */
const operatorStatus = contractProcedure('identity', 'accountControls.operatorStatus', {
  output: accountOperatorEntitlementSchema,
  input: z.object({}).strict(),
});

/** What this page knows about the signed-in person's founder entitlement. */
export type FounderCheck =
  | { kind: 'signed_out' }
  | { kind: 'checking' }
  | { kind: 'unread'; retry: () => void }
  | { kind: 'enabled' | 'revoked' | 'unconfigured' | 'not_operator' };

/**
 * `/ops` and `/platform`: this app has no operator tools. A founder whose entitlement identity reports as enabled gets the
 * console link; everyone else gets a pointer to where their own tools live, and never a founder control.
 */
export function TeamDesk({ href }: { href: string | undefined }) {
  const { userId, mode } = useSession();
  return userId ? (
    <SignedInTeamDesk href={href} userId={userId} mode={mode} />
  ) : (
    <TeamDeskView href={href} check={{ kind: 'signed_out' }} mode={mode} />
  );
}

function SignedInTeamDesk({ href, userId, mode }: { href: string | undefined; userId: string; mode: 'Personal' | 'Business' }) {
  const api = useApi();
  // The answer must be about this account; one about anybody else is unread, not trusted.
  const read = useResource(
    (signal) =>
      readContract(api, operatorStatus, {}, { signal }).then((result) =>
        result.ok && result.data.userId !== userId ? authoredRefusal('invalid_response', { key: 'loadFailed' }) : result,
      ),
    `team-desk-operator:${userId}`,
  );
  const status = read.resource;
  const check: FounderCheck =
    status.status === 'loading'
      ? { kind: 'checking' }
      : status.status === 'failed'
        ? { kind: 'unread', retry: read.reload }
        : { kind: status.data.status };
  return <TeamDeskView href={href} check={check} mode={mode} />;
}

export function TeamDeskView({ href, check, mode }: { href: string | undefined; check: FounderCheck; mode: 'Personal' | 'Business' }) {
  const { t } = appCopy.useCopy();
  return (
    <div className="legacy-room">
      <Page title={t('Separate team desk')}>
        <p>
          <a className="text-link" href="/">
            ← {t('Back to home')}
          </a>
        </p>
        <p className="muted">
          {t(
            'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.',
          )}
        </p>
        <FounderPanel href={href} check={check} mode={mode} />
      </Page>
    </div>
  );
}

function FounderPanel({ href, check, mode }: { href: string | undefined; check: FounderCheck; mode: 'Personal' | 'Business' }) {
  const { t } = appCopy.useCopy();
  if (check.kind === 'enabled')
    return (
      <EmptyState
        title={t('Open the operator console')}
        action={
          href ? (
            <a className="button button--primary" href={href} data-testid="team-desk-console">
              {t('Open Team')}
            </a>
          ) : undefined
        }
      >
        {href
          ? t('The team desk uses separate operator authentication.')
          : t('The Team deployment address is not configured. Ask your operator for the verified console address.')}
      </EmptyState>
    );
  if (check.kind === 'signed_out')
    return (
      <EmptyState
        title={t('Sign in to continue')}
        action={
          <a className="button button--primary" href="/login">
            {t('Sign in')}
          </a>
        }
      >
        {t('Sign in so this page can check whether your account is a founder account.')}
      </EmptyState>
    );
  if (check.kind === 'checking')
    return (
      <p className="muted" role="status">
        {t('Checking founder access…')}
      </p>
    );
  if (check.kind === 'unread')
    return (
      <EmptyState
        title={t('Founder access could not be checked')}
        action={
          <Button variant="secondary" onClick={check.retry}>
            {t('Retry')}
          </Button>
        }
      >
        {t('The account service did not answer, so this page offers no console link. Your sign-in is not lost; try again.')}
      </EmptyState>
    );
  const body =
    check.kind === 'revoked'
      ? t('Founder access for this account has been revoked, so this page offers no console link.')
      : check.kind === 'unconfigured'
        ? t('Founder accounts are not configured on this platform, so this page offers no console link.')
        : t('This page is for founders. Your account is not a founder account, and your own tools are in the app.');
  return (
    <EmptyState
      title={t('Nothing to open here')}
      action={
        mode === 'Business' ? (
          <a className="button button--primary" href="/pay/merchant" data-testid="team-desk-merchant">
            {t('Open merchant admin')}
          </a>
        ) : (
          <a className="button button--secondary" href="/">
            {t('Back to home')}
          </a>
        )
      }
    >
      {body}
      {mode === 'Business' ? ` ${t('Your business team, roles and settings are managed in merchant admin.')}` : ''}
    </EmptyState>
  );
}
