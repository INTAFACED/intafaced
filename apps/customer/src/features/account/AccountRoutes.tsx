import { copy, Text } from './copy';
import { Failure } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { View } from './View';
import { Verification } from './Verification';
import { Security } from './Security';
import { Account } from './Account';
import { Notifications } from './Notifications';
import { BusinessVerification } from './BusinessVerification';
import { Promotions } from './Promotions';
import { Dividends } from './Dividends';
import { OAuthConsent } from './OAuthConsent';
import { ApiKeys } from './ApiKeys';
import { ApiKeyCreate } from './ApiKeyCreate';
import { ApiKeyDetail, keyIdFromPath } from './ApiKeyDetail';
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
  if (clean === '/oauth/authorize') return <OAuthConsent />;
  if (clean === '/uc/safe') return <Security />;
  if (clean === '/uc/safe/api-keys') return <ApiKeys />;
  if (clean === '/uc/safe/api-keys/new') return <ApiKeyCreate />;
  const keyId = keyIdFromPath(path);
  if (keyId) return <ApiKeyDetail key={keyId} keyId={keyId} />;
  if (clean === '/verification') return <Verification />;
  if (clean === '/notifications') return <Notifications />;
  if (clean === '/identbusiness') return <BusinessVerification />;
  if (clean?.startsWith('/uc/promotion') || clean === '/uc/invitingmining') return <Promotions path={path} />;
  if (clean === '/uc/paydividends') return <Dividends />;
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
