import {
  createServiceSigner,
  createServiceVerifier,
  parseKeyring,
  ServiceKeyError,
  type ServiceName,
  type ServiceSigner,
  type ServiceVerifier,
} from './service-keys.js';
import type { ServiceAuthMode } from './service-auth-http.js';

/**
 * What a service builds at boot from its environment to speak S2S v3.
 *
 *   S2S_AUTH_MODE      `off` (default, and when unset): nothing changes, the shared secret is the only form.
 *                      `dual`: receivers accept a key-signed call and the shared secret. `keypair`: key-signed only.
 *   S2S_KEYRING        The public keyring JSON, the same text in every service. Public keys only.
 *   S2S_SIGNING_KID    This service's own key id in the keyring. S2S_SIGNING_KEY is its private key; both or neither.
 *
 * No private key is committed or defaulted anywhere: a real key is an owner action at launch, and tests generate theirs.
 */
export interface S2sFromEnv {
  serviceVerifier?: ServiceVerifier;
  s2sMode?: ServiceAuthMode;
  signer?: ServiceSigner;
}

/** Structural, so a service can pass its parsed env object (which also holds booleans and numbers) as it is. */
export interface S2sEnv {
  S2S_AUTH_MODE?: string | undefined;
  S2S_KEYRING?: string | undefined;
  S2S_SIGNING_KID?: string | undefined;
  S2S_SIGNING_KEY?: string | undefined;
}

export function s2sFromEnv(env: S2sEnv, self: ServiceName): S2sFromEnv {
  const mode = env.S2S_AUTH_MODE;
  if (mode === undefined || mode === 'off') return {};
  if (mode !== 'dual' && mode !== 'keypair') {
    throw new ServiceKeyError('S2S_AUTH_MODE must be exactly off, dual or keypair');
  }
  const keyringJson = env.S2S_KEYRING;
  if (keyringJson === undefined || keyringJson.trim() === '') {
    throw new ServiceKeyError(`S2S_AUTH_MODE=${mode} needs S2S_KEYRING`);
  }
  const keyring = parseKeyring(keyringJson);
  const { S2S_SIGNING_KID: kid, S2S_SIGNING_KEY: pkcs8 } = env;
  if ((kid === undefined) !== (pkcs8 === undefined)) {
    throw new ServiceKeyError('S2S_SIGNING_KID and S2S_SIGNING_KEY are set together or not at all');
  }
  return {
    serviceVerifier: createServiceVerifier({ self, keyring }),
    s2sMode: mode,
    ...(kid !== undefined && pkcs8 !== undefined
      ? { signer: createServiceSigner({ service: self, kid, privateKey: pkcs8, keyring }) }
      : {}),
  };
}
