import { LegacyRoom } from '../../app/LegacyRoom';
import type { ScreenProps } from '../../app/screen-types';

// Stub from the shell builder (B2): shows the old view inside .legacy-room until this screen is rebuilt.
// This folder's owner replaces the file; keep the default export and the ScreenProps contract.
export default function NotificationsScreen({ path, search }: ScreenProps) {
  return <LegacyRoom area="person" path={`${path}${search}`} />;
}
