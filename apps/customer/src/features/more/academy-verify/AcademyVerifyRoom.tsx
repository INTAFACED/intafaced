// volt-room: /academy/certificates/verify/:code
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { t as copyText } from '../copy';
import { CertificateVerifyPage } from '../AcademyCertificates';

/**
 * `/academy/certificates/verify/:code` on the flow template: the public certificate check a shared link opens, for
 * anyone signed in or not.
 */
export function AcademyVerifyRoom({ code }: { code: string | undefined }) {
  return (
    <FlowTemplate
      title={copyText('moreroutes.academy')}
      description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
      state={{ kind: 'ready' }}
      step={<CertificateVerifyPage code={code} />}
    />
  );
}
