// volt-room: /dex/pools
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { PoolsList } from '../pools/PoolsList';
import { TokensNav } from '../tokens/TokensRoom';
import { Answer, flag, Rows } from '../volt/answer';
import { Banner, useProtocolTab } from '../volt/frame';
import { Panel } from '../volt/parts';

/**
 * /dex/pools on the record-list template: the pools the indexer lists on the configured network, whether the AMM venue is
 * wired, and the create-pool action with the blocker it waits on.
 */
export function PoolsRoom() {
  const tab = useProtocolTab('dex', 'pools');
  const { t, dex } = tab.room;
  return (
    <div lang={tab.lang}>
      <RecordListTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        filters={
          <>
            {tab.sections}
            <TokensNav />
          </>
        }
        summary={<Banner />}
        list={
          <>
            <PoolsList />
            <Panel title={t('poolsTitle')}>
              <Answer value={dex} source={t('src_dex')} service={t('svc_dex')} t={t}>
                {(d) => <Rows rows={[[t('ammWired'), flag(t, d.ammVenueWired)]]} />}
              </Answer>
            </Panel>
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
