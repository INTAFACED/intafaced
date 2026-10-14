import './preview.css';
import { previewCopy } from './copy';

/** The line "Preview: sample numbers, not your account". Every Preview screen shows it once, near the top. */
export function PreviewCaption({ className }: { className?: string }) {
  const { t } = previewCopy.useCopy();
  return (
    <p className={className ? `if-preview-caption ${className}` : 'if-preview-caption'} data-slot="preview-caption" role="note">
      {t('Preview caption')}
    </p>
  );
}
