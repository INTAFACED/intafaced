import { useState } from 'react';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { PreviewScreen } from '../../../preview';
import './p2p.css';
import { p2pCopy } from './copy';
import { OffersBoard } from './OffersBoard';
import { TradePanel } from './TradePanel';

/** P2P Preview: the offers board (the "street rails") and a sample escrow trade with chat and an appeal. Sample data only. */
export default function P2pPreview(_props: ScreenProps) {
  const { t } = p2pCopy.useCopy();
  const [tab, setTab] = useState('offers');
  return (
    <PreviewScreen product="p2p">
      <Tabs value={tab} onValueChange={(next) => setTab(String(next))} className="pv-p2p">
        <TabsList divider className="pv-p2p__tabs">
          <TabsTab value="offers">{t('Tab offers')}</TabsTab>
          <TabsTab value="trade">{t('Tab trade')}</TabsTab>
        </TabsList>
        <TabsPanel value="offers">
          <OffersBoard />
        </TabsPanel>
        <TabsPanel value="trade">
          <TradePanel onBackToOffers={() => setTab('offers')} />
        </TabsPanel>
      </Tabs>
    </PreviewScreen>
  );
}
