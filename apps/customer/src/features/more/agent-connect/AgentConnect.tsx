import { useVenueMode, VenueFrame } from '../../trade';
import { AgentConnectRoom } from './AgentConnectRoom';

/**
 * Connect your assistant (`/agents/connect`). The person's wallet signs every venue action here, so the room sits in the
 * venue's wallet frame (its signing network); with the door off or still being read there is no venue to sign for, and
 * the room says so as before. The frame draws nothing: it only gives the room its wallet.
 */
export function AgentConnect() {
  const mode = useVenueMode();
  return mode.mode === 'on' ? (
    <VenueFrame mode={mode}>
      <AgentConnectRoom />
    </VenueFrame>
  ) : (
    <AgentConnectRoom />
  );
}
