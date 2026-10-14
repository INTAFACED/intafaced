import { useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { PreviewScreen } from '../../../preview';
import { botsFixture } from '../../../preview/fixtures/bots';
import type { SampleBotKind } from '../../../preview/fixtures/bots';
import './bots.css';
import { botsCopy } from './copy';
import { CreatePanel } from './CreatePanel';
import { Performance } from './Performance';
import { RunningBots } from './RunningBots';
import { StrategyPicker } from './StrategyPicker';

/**
 * Trading bots (Preview): three strategies, a create flow, the running list and sample results. Sample data only, from the bots
 * fixture. Every action opens the shared "nothing was sent" sheet. `?sample=empty` shows the empty lists, for checking that state.
 */
export default function BotsPreview({ search }: ScreenProps) {
  const { t } = botsCopy.useCopy();
  const [kind, setKind] = useState<SampleBotKind>('grid');
  const empty = new URLSearchParams(search).get('sample') === 'empty';
  const rows = botsFixture.rows;
  return (
    <PreviewScreen product="bots">
      <div className="if-bots">
        <p className="bots-lede">{t('Lede')}</p>
        <StrategyPicker value={kind} onChange={setKind} />
        <div className="bots-layout">
          <div className="bots-main">
            <RunningBots rows={rows} empty={empty} />
            <Performance rows={rows} empty={empty} />
          </div>
          <CreatePanel rows={rows} kind={kind} />
        </div>
      </div>
    </PreviewScreen>
  );
}
