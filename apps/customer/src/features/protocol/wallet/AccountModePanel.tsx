import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { Button, Failure, Panel } from '../../../shared/ui';
import { futuresRefusal } from '../../../screens/trade/futures/refusals';
import { useApi } from '../../session/session';
import { conventionPath } from './PortfolioPanel';
import { portfolioCopy } from './portfolio-copy';

/** svc-trade's `GET /api/v1/futures/margin-modes`: every named mode, whether it is offered, and its typed refusal. */
// hand-declared-ok: svc-trade's REST answers are declared in its handlers, not in @intafaced/contracts.
const marginModesSchema = z.object({
  modes: z.array(z.object({ mode: z.string(), offered: z.boolean(), code: z.string().nullable(), reason: z.string().nullable() })),
});
type MarginModes = z.infer<typeof marginModesSchema>;

/**
 * Accounts' account mode (D-portfolio-wallet-05, J-dex-protocol-06 #7): Standard is the one mode on our own book, with a
 * page saying what it means. Asking for portfolio margin asks svc-trade, which answers with the same check its futures
 * open door runs; its typed refusal is shown in plain words with its code, and the mode stays Standard. A read: nothing
 * is switched, signed or sent anywhere else.
 */
export function AccountModePanel() {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const api = useApi();
  const [answer, setAnswer] = useState<ApiResult<MarginModes> | null>(null);
  const [asking, setAsking] = useState(false);
  const ask = async () => {
    setAsking(true);
    setAnswer(await api.rest('/futures/margin-modes', marginModesSchema));
    setAsking(false);
  };
  const portfolio = answer?.ok ? answer.data.modes.find((row) => row.mode === 'portfolio') : undefined;
  const refusal = portfolio && !portfolio.offered && portfolio.code ? futuresRefusal({ code: portfolio.code }) : null;
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
      <Button variant="secondary" disabled={asking} onClick={() => void ask()}>
        {t('modeAsk')}
      </Button>
      {answer && !answer.ok && <Failure result={answer} retry={() => void ask()} />}
      {refusal && portfolio?.code && (
        <div role="alert" data-code={portfolio.code}>
          <strong>{refusal.title}</strong>
          <p>{refusal.body}</p>
          <p className="muted">{t('modeCode', { code: portfolio.code })}</p>
        </div>
      )}
      {portfolio?.offered && (
        <p role="alert" data-code="portfolio_offered">
          {t('modeOffered')}
        </p>
      )}
    </Panel>
  );
}
