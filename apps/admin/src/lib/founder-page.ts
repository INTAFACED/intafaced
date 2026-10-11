import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminSessionConfig, authorizeAdminRequest } from './founder-session';

export async function requireFounderPage() {
  try {
    const config = adminSessionConfig();
    const incoming = await headers();
    if (incoming.get('host') !== new URL(config.origin).host) throw new Error('admin.session_origin');
    return await authorizeAdminRequest(new Request(`${config.origin}/`, { headers: { cookie: incoming.get('cookie') ?? '' } }));
  } catch {
    redirect('/login');
  }
}
