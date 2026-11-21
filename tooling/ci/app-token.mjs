/**
 * The factory GitHub App's installation tokens, minted in memory from its key (FACTORY_APP_KEY) and narrowed to what a
 * job asks for. journeys-revert.mjs (the revert of a red merge) and journeys-revive.mjs (the held journeys) call
 * `mintToken`; the token is never printed. It moved here from the removed headless builder (factory-builder.mjs).
 */
import { createSign } from 'node:crypto';

/** The GitHub App intafaced-mac-agents (its client id is not a secret; the key is FACTORY_APP_KEY). */
export const APP_CLIENT_ID = 'Iv23lihKJK3UhiuiTgLa';

/** GitHub's API root: GITHUB_API_URL, which every Actions job sets, else github.com's (the tests plant a local one). */
const apiRoot = () => process.env.GITHUB_API_URL || 'https://api.github.com';

function api(token) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${apiRoot()}${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    return res;
  };
  return {
    json: async (path) => (await call('GET', path)).json(),
    send: async (method, path, body) => {
      const res = await call(method, path, body);
      return res.status === 204 ? null : res.json();
    },
  };
}

/** The App's JWT (RS256, nine minutes, issued a minute back for clock drift), signed with its private key. */
export function appJwt(pem, now = Date.now(), iss = APP_CLIENT_ID) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const data = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 540, iss })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(pem, 'base64url')}`;
}

/** An installation token narrowed to `spec` ({ repositories, permissions }), minted with the App's JWT; never printed. */
export async function mintToken({ pem, repo, spec, now, apiFor = api }) {
  const app = apiFor(appJwt(pem, now));
  const inst = await app.json(`/repos/${repo}/installation`);
  if (!Number.isInteger(inst?.id)) throw new Error('the App has no installation on the repository');
  const t = await app.send('POST', `/app/installations/${inst.id}/access_tokens`, spec);
  if (typeof t?.token !== 'string' || !t.token) throw new Error('GitHub returned no installation token');
  for (const [k, v] of Object.entries(spec.permissions))
    if (t.permissions?.[k] !== v) throw new Error(`the token's ${k} permission is ${t.permissions?.[k] ?? 'missing'}, not ${v}`);
  if (Object.keys(t.permissions ?? {}).some((k) => !(k in spec.permissions) && k !== 'metadata'))
    throw new Error('the token holds a permission it was not asked for');
  return t.token;
}
