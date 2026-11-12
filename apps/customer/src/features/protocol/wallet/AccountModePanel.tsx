import { useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { Button, Panel } from '../../../shared/ui';
import { futuresRefusal } from '../../../screens/trade/futures/refusals';
import { conventionPath } from './PortfolioPanel';
import { portfolioCopy } from './portfolio-copy';

/** svc-trade's typed refusal for portfolio margin on our own book (services/svc-trade/src/futures/margin-mode.ts). */
export const PORTFOLIO_MARGIN_UNSET = 'trade.portfolio_margin_unset';

/**
 * Accounts' account mode (D-portfolio-wallet-05, J-dex-protocol-06 #7): Standard is the one mode on our own book, with a
 * page saying what it means; asking for portfolio margin is answered with the futures service's own typed refusal, as the
 * futures ticket answers it, and the mode stays Standard. Nothing is sent and nothing changes.
 */
export function AccountModePanel() {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const [asked, setAsked] = useState(false);
  const refusal = futuresRefusal({ code: PORTFOLIO_MARGIN_UNSET });
  return (
    <Panel title={t('modeTitle')} aria-label={t('modeTitle')}>
      <dl className="protocol-facts">
        <div>
          <dt>{t('modeTitle')}</dt>
          <dd data-account-mode="standard">{t('modeStandard')}</dd>
        </div>
      </dl>
      <p className="muted">{t('modeNote')}</p>
      <p>
        <a href={conventionPath('modes')}>{t('modeLink')}</a>
      </p>
      <Button variant="secondary" onClick={() => setAsked(true)}>
        {t('modeAsk')}
      </Button>
      {asked && (
        <div role="alert" data-code={PORTFOLIO_MARGIN_UNSET}>
          <strong>{refusal.title}</strong>
          <p>{refusal.body}</p>
          <p className="muted">{t('modeCode', { code: PORTFOLIO_MARGIN_UNSET })}</p>
        </div>
      )}
    </Panel>
  );
}
