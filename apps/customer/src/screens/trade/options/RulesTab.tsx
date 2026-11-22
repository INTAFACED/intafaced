import { optionsCopy } from './copy';

const RULES = ['Rule call put', 'Rule european', 'Rule expiry', 'Rule collateral', 'Rule fees', 'Rule paper', 'Rule live blocked'] as const;

export function RulesTab() {
  const { t } = optionsCopy.useCopy();
  return (
    <div className="lt-stack">
      <h3 className="lt-heading">{t('How options work here')}</h3>
      <ul className="lt-points">
        {RULES.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <p className="lt-actions">
        <a className="lt-link" href="/trade/futures">
          {t('Go to Futures')}
        </a>
        <a className="lt-link" href="/execution">
          {t('Go to Execution')}
        </a>
      </p>
    </div>
  );
}
