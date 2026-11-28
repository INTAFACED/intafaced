// volt-room: /chain
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { ChainHome } from '../explorer/ChainHome';
import { NetworkPanel } from '../NetworkPanels';
import { Banner, useProtocolTab } from '../volt/frame';
import { ChainStatusPanel } from '../volt/status';

/**
 * /chain on the monitor template: chain home (the explorer search, the latest blocks and transactions), the chain's status
 * and the network panel, then the tab's actions, each disabled with its first blocker. INTACHAIN is parked: its line names
 * its blocker, and nothing here reads as INTACHAIN mainnet or audited.
 */
export function ChainRoom() {
  const tab = useProtocolTab('chain', 'status');
  const { t, chain } = tab.room;
  return (
    <div lang={tab.lang}>
      <MonitorTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        figures={[]}
        panels={
          <>
            <Banner />
            {tab.sections}
            <ChainHome chain={chain} />
            <ChainStatusPanel chain={tab.reads.chain} t={t} />
            <NetworkPanel chain={chain} t={t} />
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
