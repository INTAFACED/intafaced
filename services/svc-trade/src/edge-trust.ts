import type { edgeTrustFromEnv } from '@intafaced/config';

/** The public-key half of edge trust (see `edgeTrustFromEnv`); empty means the shared secret only. */
export type EdgeTrust = ReturnType<typeof edgeTrustFromEnv>;
