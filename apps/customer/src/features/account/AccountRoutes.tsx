import { copy, t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { Button, EmptyState, Failure, Page, Panel } from '../../shared/ui';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { View } from './View';
import { Verification } from './Verification';
import { Security } from './Security';
import { Account } from './Account';
import { Notifications } from './Notifications';
import { ReferralRecords } from './ReferralRecords';
import './account.css';

export function AccountRoutes({ path }: { path: string }) {
  const { languageFor } = copy.useCopy();
  return (
    <div lang={languageFor('accountroutes.account')} style={{ display: 'contents' }}>
      <AccountRooms path={path} />
    </div>
  );
}
function AccountRooms({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean === '/view') return <View />;
  if (clean === '/uc/safe') return <Security />;
  if (clean === '/verification') return <Verification />;
  if (clean === '/notifications') return <Notifications />;
  if (clean === '/identbusiness')
    return (
      <Page title={copyText('accountroutes.business.verification')}>
        <EmptyState
          title={copyText('accountroutes.verified.company.accounts.are.not.connected')}
          action={
            <a href="/verification" className="text-link">
              <Text k="accountroutes.view.personal.verification" />
            </a>
          }
        >
          <Text k="accountroutes.company.identity.owner.membership.and.the.associated" />
        </EmptyState>
      </Page>
    );
  if (clean?.startsWith('/uc/promotion') || clean === '/uc/invitingmining') return <Promotions />;
  if (clean === '/uc/paydividends')
    return (
      <Page title={copyText('accountroutes.dividend.records')}>
        <EmptyState title={copyText('accountroutes.dividend.history.is.not.connected')}>
          <Text k="accountroutes.there.is.no.mounted.owner.scoped.dividend" />
        </EmptyState>
        <div className="actions">
          <a className="text-link" href="/token">
            <Text k="accountroutes.open.token" />
          </a>
          <a className="text-link" href="/bank/earn">
            <Text k="accountroutes.open.earn" />
          </a>
        </div>
      </Page>
    );
  return <Account />;
}
function ResultNotice({ result }: { result: ApiResult<unknown> | null }) {
  if (!result) return null;
  return result.ok ? (
    <p className="notice" role="status">
      <Text k="accountroutes.the.service.confirmed.the.action" />
    </p>
  ) : (
    <div lang="und">
      <Failure result={result} />
    </div>
  );
}
function Promotions() {
  const { api } = useSession();
  const [result, setResult] = useState<ApiResult<{ token: string; referrerId: string; hits: number }> | null>(null);
  const [pending, setPending] = useState(false);
  const [copy, setCopy] = useState('');
  async function create() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'affiliates.createShare',
      {},
      z.object({ token: z.string().uuid(), referrerId: z.string().uuid(), hits: z.number().int() }),
    );
    setPending(false);
    setResult(response);
  }
  async function revoke() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'affiliates.revokeShare',
      {},
      z.object({ token: z.string().uuid(), referrerId: z.string().uuid(), hits: z.number().int(), revokedAt: z.string() }),
    );
    setPending(false);
    setResult(response.ok ? null : response);
  }
  const link = result?.ok ? `${location.origin}/invite?token=${encodeURIComponent(result.data.token)}` : null;
  return (
    <Page
      title={copyText('accountroutes.promotions.and.invitations')}
      description={copyText('accountroutes.create.a.share.link.for.your.account')}
    >
      <div className="split">
        <Panel title={copyText('accountroutes.your.invitation.link')}>
          <div className="stack">
            {link ? (
              <>
                <label className="field">
                  <span>
                    <Text k="accountroutes.invitation.link" />
                  </span>
                  <input readOnly value={link} lang="zxx" aria-label={copyText('accountroutes.invitation.link')} />
                </label>
                <p className="muted">
                  <Text k="accountroutes.recorded.visits" />
                  {result?.ok ? result.data.hits : '—'}
                </p>
                <div className="actions">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void navigator.clipboard.writeText(link).then(
                        () => setCopy(copyText('accountroutes.copied.invitation.link')),
                        () => setCopy(copyText('accountroutes.copy.was.unavailable.select.the.link.above')),
                      )
                    }
                  >
                    <Text k="accountroutes.copy.link" />
                  </Button>
                  <Button variant="ghost" disabled={pending} onClick={() => void revoke()}>
                    <Text k="accountroutes.revoke.link" />
                  </Button>
                </div>
                <p role="status">{copy}</p>
              </>
            ) : (
              <>
                <p className="muted">
                  <Text k="accountroutes.create.the.current.idempotent.share.token.belonging" />
                </p>
                <Button disabled={pending || (result?.ok === false && result.reason === 'uncertain')} onClick={() => void create()}>
                  <Text k="accountroutes.create.invitation.link" />
                </Button>
              </>
            )}
            {result && !result.ok && (
              <div lang="und">
                <Failure result={result} />
              </div>
            )}
          </div>
        </Panel>
        <ReferralRecords />
      </div>
    </Page>
  );
}
