// volt-room: /pay/developer/docs
// volt-room: portal:developer-docs
import { ReadingTemplate, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import { useMerchantAccess } from '../../access/MerchantAccess';
import { portalCopy } from '../../copy';
import { refusalText, refusalTitle } from '../../refusal';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { DEVELOPER_PAGES } from './pages';
import { Docs } from './Docs';

const HERE = '/pay/developer/docs';

/**
 * /pay/developer/docs (the merchant portal's developer-docs page), on the reading template: how to start, keys and
 * scopes, signing a request, the events we send with their catalogue and the receiver's guide and checker, and the
 * libraries that are not published. The developer pages stay one link each. The page draws its own title, so the
 * portal frame draws none for it; a person with no merchant account is sent to set one up, as every developer page does.
 */
export function DocsRoom({ api }: { api?: Pick<SettingsBApi, 'webhookCatalogue' | 'webhookGuide'> }) {
  const { t } = c.useCopy();
  const { t: p } = portalCopy.useCopy();
  const { access } = useMerchantAccess();
  const state: RoomState =
    access.status === 'loading'
      ? { kind: 'loading' }
      : access.status === 'failed'
        ? {
            kind: 'refused',
            refusal: {
              variant: access.failure.reason === 'unreachable' ? 'unreachable' : 'refused',
              title: refusalTitle(access.failure),
              body: refusalText(access.failure),
              reference: access.failure.requestId,
              action: access.failure.reason === 'forbidden' ? undefined : { label: p('tryAgain'), href: HERE },
            },
          }
        : access.status === 'none'
          ? {
              kind: 'empty',
              title: p('noMerchantTitle'),
              body: p('noMerchantBody'),
              action: { label: p('startSetup'), href: '/pay/onboarding' },
            }
          : { kind: 'ready' };
  return (
    <div data-room="developer-docs">
      <ReadingTemplate
        title={t('docsTitle')}
        description={t('docsPurpose')}
        state={state}
        toc={<Tabs label={t('navLabel')} current={HERE} items={DEVELOPER_PAGES.map(([, href, key]) => ({ label: t(key), href }))} />}
        body={state.kind === 'ready' ? <Docs api={api} /> : null}
      />
    </div>
  );
}
