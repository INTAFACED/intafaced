import { adminSessionErrorResponse, authorizeAdminRequest } from './founder-session';

/** Every legacy BFF requires the same live individual founder session. */
export async function adminBffGate(request: Request): Promise<Response | null> {
  try {
    await authorizeAdminRequest(request);
    return null;
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
