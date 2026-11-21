/**
 * execution.arbitrage fleet compose + OMS consumer wiring honesty checks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function executionComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-execution');
}

export function edgeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-edge');
}

export function executionRouterSource(): string {
  return readFileSync(join(ROOT, 'services/svc-execution/src/router.ts'), 'utf8');
}

export function executionSpineSource(): string {
  return readFileSync(join(ROOT, 'services/svc-execution/src/oms-spine.ts'), 'utf8');
}

export function executionArbPlanLegsSource(): string {
  return readFileSync(join(ROOT, 'services/svc-execution/src/oms-arb-plan-legs.ts'), 'utf8');
}

export function executionArbExecuteLegsSource(): string {
  return readFileSync(join(ROOT, 'services/svc-execution/src/oms-arb-execute-legs.ts'), 'utf8');
}

export function edgeControlPlaneSource(): string {
  return readFileSync(join(ROOT, 'services/svc-edge/src/control-plane.ts'), 'utf8');
}

export function arbCapitalComposeWired(): boolean {
  const block = executionComposeBlock();
  return /EXECUTION_ARB_MAX_QUOTE_AGE_MS:\s*\$\{EXECUTION_ARB_MAX_QUOTE_AGE_MS:-\}/.test(block);
}

export function arbScanDoorWiredInExecution(): boolean {
  const router = executionRouterSource();
  const spine = executionSpineSource();
  return /arb:\s*router\(/.test(router) && /scanOmsExternalArb/.test(router) && /execution\.arb\.scan/.test(spine);
}

export function arbPlanLegsDoorWiredInExecution(): boolean {
  const router = executionRouterSource();
  const spine = executionSpineSource();
  return /planLegs:\s*/.test(router) && /planOmsArbAtomicLegs/.test(router) && /execution\.arb\.planLegs/.test(spine);
}

export function arbExecuteLegsDoorWiredInExecution(): boolean {
  const router = executionRouterSource();
  const spine = executionSpineSource();
  return /executeLegs:\s*/.test(router) && /executeOmsArbAtomicLegs/.test(router) && /execution\.arb\.executeLegs/.test(spine);
}

/** OMS plan door must declare the group non-atomic — naming leftover is not a success contract. */
export function omsArbPlanLegsDeclaredNonAtomic(): boolean {
  const src = executionArbPlanLegsSource();
  return /atomic:\s*false/.test(src) && !/atomic:\s*true/.test(src);
}

/** OMS execute must not return ok:true after a refused or unknown child. */
export function omsArbExecuteLegsFailedUnknownNotSuccess(): boolean {
  const src = executionArbExecuteLegsSource();
  const failureHelperSetsOkFalse = /function failure\([\s\S]*?return \{[\s\S]*?ok:\s*false/.test(src);
  const unknownChildReturnsFailure = /if \(child\.outcome === 'OUTCOME_UNKNOWN'\)[\s\S]*?return failure\(/.test(src);
  const unknownSubmitReturnsFailure = /outcome: 'OUTCOME_UNKNOWN'[\s\S]*?return failure\(/.test(src);
  const refusedChildReturnsFailure = /child was already refused; retry is fenced/.test(src);
  return failureHelperSetsOkFalse && unknownChildReturnsFailure && unknownSubmitReturnsFailure && refusedChildReturnsFailure;
}

export function arbReachableFromEdgeCompose(): boolean {
  const block = edgeComposeBlock();
  return /EXECUTION_URL:\s*http:\/\/svc-execution:4019/.test(block);
}

export function arbScanConsumerDoorOnEdge(): boolean {
  return (
    /registerExecutionArbScanConsumerRoutes/.test(edgeControlPlaneSource()) &&
    /execution-arb-scan-consumer-door/.test(edgeControlPlaneSource())
  );
}

export function arbOmsWireClosed(): boolean {
  return (
    arbCapitalComposeWired() &&
    arbScanDoorWiredInExecution() &&
    arbPlanLegsDoorWiredInExecution() &&
    arbExecuteLegsDoorWiredInExecution() &&
    omsArbPlanLegsDeclaredNonAtomic() &&
    omsArbExecuteLegsFailedUnknownNotSuccess() &&
    arbReachableFromEdgeCompose() &&
    arbScanConsumerDoorOnEdge()
  );
}
