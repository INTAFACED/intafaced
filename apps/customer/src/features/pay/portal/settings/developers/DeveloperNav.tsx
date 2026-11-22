import { Tabs } from '@intafaced/ui/lit/templates';
import { developersCopy as c } from './copy';

const links = [
  ['developer-keys', '/pay/developer/keys', 'navKeys'],
  ['developer-signing', '/pay/developer/signing', 'navSigning'],
  ['developer-webhooks', '/pay/developer/webhooks', 'navWebhooks'],
  ['developer-deliveries', '/pay/developer/deliveries', 'navDeliveries'],
  ['developer-sandbox', '/pay/developer/sandbox', 'navSandbox'],
  ['developer-docs', '/pay/developer/docs', 'navDocs'],
] as const;

/** The developer pages live under Settings; this row moves between them. It wraps at phone width. */
export function DeveloperNav({ room }: { room: string }) {
  const { t } = c.useCopy();
  const here = room === 'developer-endpoint' ? 'developer-webhooks' : room;
  return (
    <Tabs
      label={t('navLabel')}
      current={links.find(([id]) => id === here)?.[1] ?? ''}
      items={links.map(([, href, key]) => ({ label: t(key), href }))}
    />
  );
}
