import { CopyButton } from '@intafaced/ui/lit/templates';
import { accountScreenCopy } from '../../../screens/account/copy';

/** The kit's copy button in the words `CopyButton` (screens/account) says: Copy, Copied, and the copy-failed line. */
export function Copy({ value, label }: { value: string; label?: string }) {
  const { t } = accountScreenCopy.useCopy();
  return (
    <CopyButton
      value={value}
      label={label ?? t('Copy account ID')}
      words={{ copy: t('Copy'), copied: t('Copied'), failed: t('Copy failed') }}
    />
  );
}
