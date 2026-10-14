import { adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { authorizedInput, currentPasswordInput, newPasswordInput, signedOutResponse, SECURITY_UPSTREAM } from '../guard';

export const dynamic = 'force-dynamic';

/** Change the password. The current password is checked by svc-identity; on success the founder is signed out and signs in again. */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['currentPassword', 'newPassword']);
    const currentPassword = currentPasswordInput(input.currentPassword);
    const newPassword = newPasswordInput(input.newPassword);
    await founderEdgeCall(config, 'identity', 'auth.changePassword', 'POST', { currentPassword, newPassword }, session.accessToken);
    return await signedOutResponse(config, session);
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
