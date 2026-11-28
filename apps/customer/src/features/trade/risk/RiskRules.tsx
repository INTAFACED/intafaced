// volt-room: /trade/risk/rules
import type { ReactNode } from 'react';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { Section } from '../../more';
import { useVenueMode, type VenueMode } from '../use-venue-mode';
import { useOwner } from '../venue/VenueKit';
import { TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { DailyLossRule } from './DailyLossParts';
import { dailyLossCopy } from './daily-loss-copy';

/**
 * Risk rules (J-derivatives-35): the rules a person sets on their own venue account, starting with the daily loss limit.
 * Off until they turn it on; svc-trade keeps it and judges every opening order against it (src/venue/daily-loss-limit.ts).
 * Nothing moves here: the venue holds the account and the ledger posts nothing.
 */
export function RiskRules() {
  const { t } = dailyLossCopy.useCopy();
  const { userId } = useSession();
  const mode = useVenueMode();
  const frame = {
    title: t('title'),
    description: t('lead'),
    mode: 'pro' as const,
    figures: [],
    explain: <p className="lt-hint">{t('explain')}</p>,
  };
  if (!userId)
    return (
      <MonitorTemplate
        {...frame}
        state={{
          kind: 'empty',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Ftrade%2Frisk%2Frules' },
        }}
      />
    );
  if (mode.mode === 'checking') return <MonitorTemplate {...frame} state={{ kind: 'loading' }} />;
  if (mode.mode !== 'on' || !mode.status.available)
    return <MonitorTemplate {...frame} state={{ kind: 'empty', title: t('noVenueTitle'), body: t('noVenueBody') }} />;
  return <OnVenue mode={mode} frame={frame} />;
}

function OnVenue({
  mode,
  frame,
}: {
  mode: Extract<VenueMode, { mode: 'on' }>;
  frame: { title: string; description: string; mode: 'pro'; figures: never[]; explain: ReactNode };
}) {
  const status = mode.status;
  if (!status.available) return null;
  return (
    <VenueFrame mode={mode}>
      <MonitorTemplate
        {...frame}
        state={{ kind: 'ready' }}
        actions={
          <div className="lt-stack">
            <TestMark test={status.test} />
            <WalletBar />
          </div>
        }
        panels={<Owned />}
      />
    </VenueFrame>
  );
}

function Owned() {
  const { t } = dailyLossCopy.useCopy();
  const owner = useOwner();
  if (!owner)
    return (
      <Section title={t('heading')}>
        <p data-testid="daily-loss-connect">{t('connect')}</p>
      </Section>
    );
  return <DailyLossRule owner={owner} />;
}
