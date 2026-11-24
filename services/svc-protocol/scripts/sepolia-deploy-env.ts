/** CLI re-export — parser lives under src/ so tests stay inside rootDir. */
export {
  assertNotDevKey,
  BANNED_LIVE_CHAIN_IDS,
  CIRCLE_USDC_BASE_SEPOLIA,
  createAddressAfterOneTx,
  ENTRYPOINT_V07,
  namedAddress,
  parseSepoliaDeployEnv,
  SEPOLIA_CHAIN_ID,
} from '../src/deployments/sepolia-deploy-env.js';
export type { SepoliaDeployEnv } from '../src/deployments/sepolia-deploy-env.js';
