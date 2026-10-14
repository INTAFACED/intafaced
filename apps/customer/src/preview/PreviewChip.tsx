import './preview.css';
import { previewCopy } from './copy';

/**
 * The small "Preview" label. Put it next to every tab, menu item or panel title of a product that is not live yet.
 * Outlined and grey on purpose: lime is for action and brand, amber is for warnings.
 */
export function PreviewChip({ className }: { className?: string }) {
  const { t } = previewCopy.useCopy();
  return (
    <span className={className ? `if-preview-chip ${className}` : 'if-preview-chip'} data-slot="preview-chip">
      {t('Preview')}
    </span>
  );
}
