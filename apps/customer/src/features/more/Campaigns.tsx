import { t as copyText, Text } from './copy';
import { Panel } from '../../shared/ui';

export function Campaigns() {
  return (
    <div className="more-columns">
      <Panel title={copyText('campaigns.your.activity')}>
        <p role="status">
          <Text k="campaigns.activity.unavailable" />
        </p>
        <p className="muted">
          <Text k="campaigns.participation.unavailable" />
        </p>
      </Panel>
      <Panel title={copyText('campaigns.discover')}>
        <p>
          <Text k="campaigns.public.details" />
        </p>
        <a className="text-link" href="/lab">
          <Text k="campaigns.open.public.campaigns" />
        </a>
      </Panel>
    </div>
  );
}
