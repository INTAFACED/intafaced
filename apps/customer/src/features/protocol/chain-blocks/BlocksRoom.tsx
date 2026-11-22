import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { BlocksList } from '../explorer/pages';
import { Answer, flag, orNone, Rows } from '../volt/answer';
import { Banner, useProtocolTab } from '../volt/frame';
import { Panel } from '../volt/parts';

/**
 * /chain/blocks on the record-list template (D-explorer-02): the newest blocks from the indexer with the gas tracker,
 * then the indexer's own status. The chain is parked: nothing here reads as INTACHAIN mainnet.
 */
export function BlocksRoom() {
  const tab = useProtocolTab('chain', 'blocks');
  const { t, chain, indexer } = tab.room;
  return (
    <div lang={tab.lang}>
      <RecordListTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        filters={tab.sections}
        summary={<Banner />}
        list={
          <>
            <BlocksList chain={chain} />
            <Panel title={t('tab_blocks')}>
              <p className="lt-hint">{t('blocksNote')}</p>
              <Answer value={indexer} source={t('src_indexer')} service={t('svc_indexer')} t={t}>
                {(i) => (
                  <>
                    <Rows
                      rows={[
                        [t('chainSource'), i.chainSource],
                        [t('indexedHeight'), orNone(t, i.indexedHeight)],
                        [t('finalizedHeight'), orNone(t, i.finalizedHeight)],
                        [t('finalityDepth'), i.finalityDepth],
                        [t('behindBy'), orNone(t, i.behindBy)],
                        [t('ingest'), flag(t, i.ingestEnabled)],
                        [t('halted'), i.halted ? t('haltedAt', { reason: i.halted.reason, at: i.halted.at }) : t('notHalted')],
                        [t('lastError'), i.lastError ? `${i.lastError.code ?? ''} ${i.lastError.message}`.trim() : t('noLastError')],
                      ]}
                    />
                    {i.finalizedHeight === null && <p className="lt-hint">{t('notFinal')}</p>}
                  </>
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
