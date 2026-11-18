import type { ReactNode } from 'react';
import { Quant } from '../more/Quant';
import { t as moreCopy } from '../more/copy';
import { AlgoHome } from './AlgoHome';
import { BacktestRoom } from './BacktestRoom';
import { StrategiesRoom } from './StrategiesRoom';
import { LimitsRoom } from './LimitsRoom';
import { limitsCopy } from './limits-copy';
import { StrategyPage } from './StrategyPage';
import { SharedRoom, SharedStrategy } from './SharedRooms';
import { teamCopy } from './team-copy';
import { LibraryRoom, ListingRoom } from './LibraryRooms';
import { libraryCopy } from './library-copy';
import { LiveRun, LiveRuns } from './LiveRun';
import { liveRunCopy } from './live-run-copy';
import { EditorRoom, OptimiseRoom, TesterRoom } from './PreviewRooms';
import { previewCopy } from './preview-copy';
import { strategyPageCopy } from './strategy-page-copy';
import { strategiesCopy } from './strategies-copy';
import { algoCopy } from './algo-copy';
import { LakeRoom } from './LakeRoom';
import { researchCopy } from './research-copy';

const MODES = { '/quant/studio': 'studio', '/quant/backtest': 'backtest', '/quant/sandbox': 'sandbox' } as const;

/** The Algo dev rooms under `/quant`; `MoreRoutes` hands the whole prefix here. Null for a path that is not one of them. */
export function quantRoute(
  pathname: string,
  paper: boolean,
  userId: string | null,
): { title: ReactNode; description: ReactNode; content: ReactNode } | null {
  if (pathname === '/quant') {
    return {
      title: algoCopy.t('title'),
      description: algoCopy.t('description'),
      content: <AlgoHome key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const strategy = /^\/quant\/strategies\/([^/]+)$/.exec(pathname);
  if (strategy) {
    let strategyId = strategy[1]!;
    try {
      strategyId = decodeURIComponent(strategyId);
    } catch {
      // A broken escape is sent as it is, and the service answers that no such strategy exists.
    }
    return {
      title: strategyPageCopy.t('roomTitle'),
      description: strategyPageCopy.t('description'),
      content: <StrategyPage key={`${userId ?? 'anonymous'}:${strategyId}`} strategyId={strategyId} paper={paper} />,
    };
  }
  // Strategies other people shared with the caller, and one of them (J-algo-dev-08).
  if (pathname === '/quant/shared') {
    return {
      title: teamCopy.t('sharedTitle'),
      description: teamCopy.t('sharedIntro'),
      content: <SharedRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const shared = /^\/quant\/shared\/([^/]+)$/.exec(pathname);
  if (shared) {
    let strategyId = shared[1]!;
    try {
      strategyId = decodeURIComponent(strategyId);
    } catch {
      // A broken escape is sent as it is, and the service answers that no such strategy is shared.
    }
    return {
      title: teamCopy.t('sharedTitle'),
      description: teamCopy.t('sharedIntro'),
      content: <SharedStrategy key={`${userId ?? 'anonymous'}:${strategyId}`} strategyId={strategyId} paper={paper} />,
    };
  }
  // The strategy library (J-algo-dev-09): what people published, and one listing.
  if (pathname === '/quant/library') {
    return {
      title: libraryCopy.t('libraryTitle'),
      description: libraryCopy.t('libraryIntro'),
      content: <LibraryRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const listing = /^\/quant\/library\/([^/]+)$/.exec(pathname);
  if (listing) {
    let listingId = listing[1]!;
    try {
      listingId = decodeURIComponent(listingId);
    } catch {
      // A broken escape is sent as it is, and the service answers that no such listing exists.
    }
    return {
      title: libraryCopy.t('libraryTitle'),
      description: libraryCopy.t('libraryIntro'),
      content: <ListingRoom key={`${userId ?? 'anonymous'}:${listingId}`} listingId={listingId} paper={paper} />,
    };
  }
  // A live strategy run on the person's own venue sub-account (J-algo-dev-07), and the list of them.
  if (pathname === '/quant/live') {
    return {
      title: liveRunCopy.t('listTitle'),
      description: liveRunCopy.t('description'),
      content: <LiveRuns key={userId ?? 'anonymous'} />,
    };
  }
  const live = /^\/quant\/live\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (live) {
    return {
      title: liveRunCopy.t('roomTitle'),
      description: liveRunCopy.t('description'),
      content: <LiveRun key={`${userId ?? 'anonymous'}:${live[1]}`} runId={live[1]!.toLowerCase()} />,
    };
  }
  // The Preview rooms (AL-order-01): full layouts on TEST sample data; every engine action is refused by name.
  if (pathname === '/quant/editor' || pathname === '/quant/tester' || pathname === '/quant/optimise') {
    const room = pathname.slice('/quant/'.length) as 'editor' | 'tester' | 'optimise';
    const Room = room === 'editor' ? EditorRoom : room === 'tester' ? TesterRoom : OptimiseRoom;
    return {
      title: previewCopy.t(room === 'editor' ? 'editorTitle' : room === 'tester' ? 'testerTitle' : 'optimiseTitle'),
      description: previewCopy.t('label'),
      content: <Room key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  // The market data lake (J-algo-dev-16 #2).
  if (pathname === '/quant/data') {
    return {
      title: researchCopy.t('dataTitle'),
      description: researchCopy.t('dataIntro'),
      content: <LakeRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  // Every limit a developer's runs meet (J-algo-dev-12 #4).
  if (pathname === '/quant/limits') {
    return {
      title: limitsCopy.t('title'),
      description: limitsCopy.t('description'),
      content: <LimitsRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  if (pathname === '/quant/strategies') {
    return {
      title: strategiesCopy.t('title'),
      description: strategiesCopy.t('description'),
      content: <StrategiesRoom key={userId ?? 'anonymous'} paper={paper} />,
    };
  }
  const mode = MODES[pathname as keyof typeof MODES];
  if (!mode) return null;
  return {
    title:
      mode === 'sandbox'
        ? moreCopy('moreroutes.quant.sandbox')
        : mode === 'studio'
          ? moreCopy('moreroutes.quant.studio')
          : moreCopy('moreroutes.backtest'),
    description: moreCopy('moreroutes.simulated.strategy.research.with.explicit.historical.evidence'),
    content:
      mode === 'backtest' ? (
        // The bar backtest runs saved signal rules; the walk-forward record below keeps its own named refusal.
        <>
          <BacktestRoom key={`bars:${userId}`} />
          <Quant key={`${pathname}:${userId}`} paper={paper} mode={mode} />
        </>
      ) : (
        <Quant key={`${pathname}:${userId}`} paper={paper} mode={mode} />
      ),
  };
}
