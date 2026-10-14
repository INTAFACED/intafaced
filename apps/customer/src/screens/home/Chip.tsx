import { homeCopy } from './copy';

/**
 * The small "Preview" label every Preview link carries: outlined, grey (lime is reserved for action and brand).
 * On a lime button it takes the button's own dark text instead of grey.
 */
export function PreviewChip({ onLime = false }: { onLime?: boolean }) {
  const { t } = homeCopy.useCopy();
  return <span className={onLime ? 'home-chip home-chip--on-lime' : 'home-chip'}>{t('Preview')}</span>;
}
