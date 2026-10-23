/**
 * The address the HTTP server binds. HTTP_HOST names it (the local test stack binds 127.0.0.1, like every other
 * service); unset or blank keeps 0.0.0.0 for the compose network.
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HTTP_HOST?.trim() || '0.0.0.0';
}
