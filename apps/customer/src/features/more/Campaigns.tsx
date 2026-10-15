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
        <p role="status">
          <Text k="campaigns.discovery.unavailable" />
        </p>
        <p className="muted">
          <Text k="campaigns.public.details" />
        </p>
      </Panel>
    </div>
  );
}
