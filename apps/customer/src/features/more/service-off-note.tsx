import { ServiceOffNotice, type NotConnectedCode } from '@intafaced/ui/lit/templates';
import { serviceOffCopy } from '../../shared/service-off';

/** The shell's service-off notice (HM-shell-03) in a room on the kit: the kit's notice with the allowlist's own sentence. */
export function ServiceOffNote({ code, action, role }: { code: NotConnectedCode; action: string; role?: 'note' | 'status' }) {
  const { t } = serviceOffCopy.useCopy();
  return <ServiceOffNotice code={code} sentence={t('sentence', { action, dependency: t(code) })} role={role} />;
}
