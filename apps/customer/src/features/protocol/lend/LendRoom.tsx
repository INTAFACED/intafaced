// volt-room: /dex/lend
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { TokensNav } from '../tokens/TokensRoom';
import { Banner, useProtocolTab } from '../volt/frame';
import { LendPanel } from './LendPanel';

/**
 * /dex/lend on the monitor template: the connected wallet's position in the isolated lending market, read from the market
 * contract (LendPanel), the room's sections, and the tab's actions, each disabled with the blocker it waits on.
 */
export function LendRoom() {
  const tab = useProtocolTab('dex', 'lend');
  const { t, api } = tab.room;
  return (
    <div lang={tab.lang}>
      <MonitorTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={
          <>
            {tab.sections}
            <TokensNav />
          </>
        }
        panels={
          <>
            <Banner />
            <LendPanel api={api} t={t} />
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
