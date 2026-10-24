import { z } from 'zod';
import { safeReturnTo } from '../../app/navigation';

type AuthContext = {
  destination: string;
  hasReturn: boolean;
  invite?: string;
};

export function publicAuthContext(path: string, search: string): AuthContext {
  const params = new URLSearchParams(search);
  const invitation = z
    .string()
    .guid()
    .safeParse(params.get(path === '/invite' ? 'token' : 'invite'));
  let requested = params.get('redirect');
  if (!requested && path.startsWith('/login/returnUrl/')) {
    try {
      requested = decodeURIComponent(path.slice('/login/returnUrl/'.length));
    } catch {
      requested = null;
    }
  }
  return {
    destination: safeReturnTo(requested),
    hasReturn: Boolean(requested),
    ...(invitation.success ? { invite: invitation.data } : {}),
  };
}

export function publicAuthHref(context: AuthContext, path: '/login' | '/register' | '/findPwd', fresh = false): string {
  const params = new URLSearchParams();
  if (context.hasReturn || fresh) params.set('redirect', context.destination);
  if (context.invite) params.set('invite', context.invite);
  return `${path}${params.size ? `?${params}` : ''}`;
}
