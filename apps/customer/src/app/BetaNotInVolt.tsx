import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { appCopy } from './app-copy';

/**
 * What the beta's build draws, in the kit, for a room not yet in Volt reached by its address (beta-volt.ts): the room
 * keeps its route, and the person gets an honest way back to Home. Other builds never draw it.
 */
export function BetaNotInVolt() {
  const { t } = appCopy.useCopy();
  return (
    <MonitorTemplate
      title={t('Not in this beta')}
      state={{
        kind: 'empty',
        title: t('This room is not part of this beta'),
        body: t('The beta shows only the rooms in the new design.'),
        action: { label: t('Back to home'), href: '/home' },
      }}
      figures={[]}
    />
  );
}
