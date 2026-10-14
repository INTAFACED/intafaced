import { copy, t as copyText, Text } from './copy';
import { EmptyState, Failure, Page } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { View } from './View';
import { Account } from './Account';
import { Notifications } from './Notifications';
import { Promotions } from './Promotions';
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
