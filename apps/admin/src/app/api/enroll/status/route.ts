import {
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  founderEdgeCall,
} from '@/lib/founder-session';
import { enrolmentIsOpen, enrolmentOffResponse } from '@/lib/enrolment-session';

export const dynamic = 'force-dynamic';

/** Whether identity is still taking founder enrolments. Public, and says nothing else. */
export async function GET(request: Request) {
  if (!enrolmentIsOpen()) return enrolmentOffResponse();
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, false);
    const raw = await founderEdgeCall(config, 'identity', 'auth.founderEnrolmentStatus', 'GET', {});
    if (!raw || typeof raw !== 'object' || typeof (raw as { open?: unknown }).open !== 'boolean')
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ open: (raw as { open: boolean }).open }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
