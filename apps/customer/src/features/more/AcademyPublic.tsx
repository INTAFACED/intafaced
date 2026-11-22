import { useState } from 'react';
import { navigate } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { EmptyState, Panel, Tabs } from '../../shared/ui';
import './academy-public.css';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyTabHref, academyTabs, type AcademyRoute } from './academy-lms';
import { VerifyPanel } from './AcademyCertificates';

/**
 * The Academy's pages under the five tabs for a visitor with no account (J-academy-01) that are not yet on their Volt
 * template: Certificates and progress with the public certificate check, an assignment, and a course discussion, each
 * saying the personal parts need sign-in. Learning, Rooms, Videos and Programmes are their own Volt rooms
 * (academy-catalogue/). Nothing here reads or writes a learner record.
 */

function SignIn() {
  const { Copy } = copy.useCopy();
  const here = safeReturnTo(location.pathname + location.search);
  return (
    <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
      <Copy k="publicSignIn" />
    </a>
  );
}

export function AcademyPublic({ route }: { route: AcademyRoute }) {
  const tab =
    route.kind === 'tab'
      ? route.tab
      : route.kind === 'reader' || route.kind === 'course' || route.kind === 'assignment'
        ? 'Learning'
        : route.kind === 'programme'
          ? 'Programmes'
          : '';
  const { t } = copy.useCopy();
  return (
    <div className="more-grid" data-academy-visitor="true">
      <Tabs
        items={academyTabs.map(([name]) => name)}
        labels={{
          Learning: copyText('academy.learning'),
          Certificates: copyText('academy.certificates'),
          Rooms: copyText('academy.rooms'),
          Videos: copyText('academy.videos'),
          Programmes: copyText('academy.programmes'),
        }}
        value={tab}
        onChange={(next) => {
          const target = academyTabs.find(([name]) => name === next);
          if (target && (next !== tab || route.kind !== 'tab')) navigate(academyTabHref(target[0]));
        }}
        label={copyText('academy.academy.sections')}
      />
      {route.kind === 'assignment' ? (
        <Panel title={copyText('academy.learning')}>
          <EmptyState title={t('asgSignIn')} action={<SignIn />} />
        </Panel>
      ) : route.kind === 'progress' || tab === 'Certificates' ? (
        <PublicCertificates />
      ) : tab === 'Rooms' ? (
        <Panel title={copyText('academy.rooms')}>
          <EmptyState title={t('publicRoomsSignIn')} action={<SignIn />} />
        </Panel>
      ) : null}
    </div>
  );
}

function PublicCertificates() {
  const { t } = copy.useCopy();
  // Checking a certificate's code needs no account: the verify box is the same one signed-in learners use.
  const [reference, setReference] = useState(new URLSearchParams(location.search).get('verify') ?? '');
  return (
    <div className="more-columns">
      <Panel title={copyText('academy.certificates')}>
        <EmptyState title={t('publicCertificatesSignIn')} action={<SignIn />} />
      </Panel>
      <VerifyPanel reference={reference} onReference={setReference} />
    </div>
  );
}
