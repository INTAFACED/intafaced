import { adminSessionErrorResponse, authorizeAdminRequest, type AdminSessionConfig, type FounderSession } from './founder-session';

/** Every legacy BFF requires the same live individual founder session. */
export async function adminBffGate(request: Request): Promise<Response | null> {
  try {
    await authorizeAdminRequest(request);
    return null;
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

/**
 * The same gate for a route that must act AS the founder (propose, approve, claim, set a halt): it hands back the
 * verified session instead of discarding it. A refusal is the response to return unchanged.
 */
export async function adminBffSession(request: Request): Promise<{ session: FounderSession; config: AdminSessionConfig } | Response> {
  try {
    return await authorizeAdminRequest(request);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
