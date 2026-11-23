// volt-room: /protocol
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { Answer, flag, Rows } from '../volt/answer';
import { Banner, useProtocolTab } from '../volt/frame';
import { Panel } from '../volt/parts';
import { ChainStatusPanel } from '../volt/status';

/**
 * /protocol on the monitor template: the chain's status and the Protocol Plane's own health (relay and factory), then the
 * tab's actions, each disabled with its first blocker. Nothing here reads as INTACHAIN mainnet or audited.
 */
export function OverviewRoom() {
  const tab = useProtocolTab('protocol', 'overview');
  const { t } = tab.room;
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
            <ChainStatusPanel chain={tab.reads.chain} t={t} />
            <Panel title={t('tab_overview')}>
              <Answer value={tab.reads.health} source={t('src_health')} t={t}>
                {(h) => (
                  <Rows
                    t={t}
                    rows={[
                      [t('relayEnabled'), flag(t, h.relayEnabled)],
                      [t('factoryConfigured'), flag(t, h.factoryConfigured)],
                    ]}
                  />
                )}
              </Answer>
            </Panel>
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
