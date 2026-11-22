import { useEffect, useRef } from 'react';

/**
 * The token a status mail link carries (`?token=`), read once. It leaves the address bar as soon as it is read, so it is
 * not kept in history or shared by a copied address. Every status link page reads it this way.
 */
export function useLinkToken(): string {
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  useEffect(() => {
    if (location.search) history.replaceState(history.state, '', location.pathname);
  }, []);
  return token;
}
