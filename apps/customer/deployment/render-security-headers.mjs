import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const customer = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Renders the nginx security-headers snippet the way the container does at start: csp-origins.envsh is sourced (as the nginx
 * entrypoint does) to build the two CUSTOMER_CSP_* values from the deploy-time variables, then those two placeholders in
 * security-headers.conf.template are replaced (the entrypoint's envsubst, restricted by NGINX_ENVSUBST_FILTER, does the same).
 * Throws with the script's own message when a variable is invalid, as the container would refuse to start.
 */
export function renderSecurityHeaders(env = {}) {
  const sourced = spawnSync(
    'sh',
    ['-c', '. "$1" && printf "%s\\n%s" "$CUSTOMER_CSP_MEDIA_SRC" "$CUSTOMER_CSP_CONNECT_SRC"', 'sh', join(customer, 'csp-origins.envsh')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } },
  );
  if (sourced.status !== 0) throw new Error(sourced.stderr.trim() || `csp-origins.envsh exited ${sourced.status}`);
  const [media, connect] = sourced.stdout.split('\n');
  const values = { CUSTOMER_CSP_MEDIA_SRC: media, CUSTOMER_CSP_CONNECT_SRC: connect };
  const rendered = readFileSync(join(customer, 'security-headers.conf.template'), 'utf8').replace(
    /\$\{(CUSTOMER_CSP_[A-Z_]+)\}/g,
    (_, name) => values[name] ?? `\${${name}}`,
  );
  return rendered;
}

/** Writes both snippets into `directory` (as /etc/nginx/snippets would hold them) and returns the rendered full snippet. */
export function installSnippets(directory, env = {}) {
  mkdirSync(directory, { recursive: true });
  const rendered = renderSecurityHeaders(env);
  writeFileSync(join(directory, 'security-headers.conf'), rendered);
  copyFileSync(join(customer, 'security-headers-api.conf'), join(directory, 'security-headers-api.conf'));
  return rendered;
}
