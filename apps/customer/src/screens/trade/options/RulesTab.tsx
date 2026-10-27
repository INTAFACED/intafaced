import { optionsCopy } from './copy';

const RULES = ['Rule call put', 'Rule european', 'Rule expiry', 'Rule collateral', 'Rule fees', 'Rule paper', 'Rule live blocked'] as const;

export function RulesTab() {
  const { t } = optionsCopy.useCopy();
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h3 className="m-0 text-md font-medium text-fg">{t('How options work here')}</h3>
      <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-sm text-fg-2">
        {RULES.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <p className="m-0 flex gap-4 text-sm">
        <a className="text-accent-text hover:underline" href="/trade/futures">
          {t('Go to Futures')}
        </a>
        <a className="text-accent-text hover:underline" href="/execution">
          {t('Go to Execution')}
        </a>
      </p>
    </div>
  );
}
