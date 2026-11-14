/**
 * The agents beside the user-venue door (J-agents-21, J-agents-08): the agent account, the assistant's trade path, its
 * Activity, the founder's desk and a person's own agent trading. Each is off with the door. index.ts calls
 * `wireVenueAgents` once, so a journey that adds to the agents edits this file, not the service's wiring file.
 */
import type { Sql } from 'postgres';
import type { ServiceAuthMode, ServiceSigner, StepUpCheck } from '@intafaced/contracts';
import { env } from '../env.js';
import { AgentAccounts, parseAgentAccountValues } from './agent-account.js';
import { SqlAgentAccountStore } from './agent-account-store.js';
import { SqlAgentConnectionStore } from './agent-connection-store.js';
import { AgentDesk } from './agent-desk.js';
import { SqlAgentDeskAuditStore } from './agent-desk-store.js';
import { createAgentKeyCallReader, createAgentKeyReader } from './agent-key-read-client.js';
import { AgentActivity, SqlAgentOrderCallStore } from './agent-order-calls.js';
import { AgentOrders } from './agent-orders.js';
import { SqlAllowanceStore } from './own-agent-allowance-store.js';
import { createOwnAgentPolicy } from './own-agent-policy-client.js';
import { OwnAgentTrading } from './own-agent-trading.js';
import type { UserVenueDoor } from './user-venue-door.js';

export function wireVenueAgents(deps: {
  sql: Sql;
  userVenue: UserVenueDoor | null;
  stepUp: StepUpCheck;
  outS2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}) {
  const { sql, userVenue, stepUp, outS2s } = deps;
  // J-agents-21's agent account beside the door: off with it. Its owner values are read even when blank (each refuses).
  const agentAccountStore = new SqlAgentAccountStore(sql);
  const agentAccountValues = parseAgentAccountValues(env);
  const agentAccounts = userVenue
    ? new AgentAccounts({
        door: userVenue,
        store: agentAccountStore,
        stepUp,
        values: agentAccountValues,
        now: () => new Date(),
      })
    : null;
  // The assistant's trade path on its agent account (J-agents-21 #6 #7 #10): one capped signer per agent key, in this
  // process. Off with the door. Identity is asked, through its own door, that a key is the person's own agent key.
  const agentConnectionStore = new SqlAgentConnectionStore(sql);
  const agentOrders = userVenue
    ? new AgentOrders({
        door: userVenue,
        accounts: agentAccountStore,
        connections: agentConnectionStore,
        keys: createAgentKeyReader(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s),
        stepUp,
        values: agentAccountValues,
        now: () => new Date(),
      })
    : null;
  // The assistant connection's Activity (J-agents-21 #11): identity's call log of the key, read through its own door, with
  // what svc-trade answered each call of the assistant's order route. Off with the door.
  const agentActivity = userVenue
    ? new AgentActivity({
        connections: agentConnectionStore,
        calls: createAgentKeyCallReader(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s),
        log: new SqlAgentOrderCallStore(sql),
        now: () => new Date(),
      })
    : null;
  // The founder's desk over every outside assistant connection (J-agents-21 #15): read and quarantined as the founder
  // through svc-edge (admin.agentDesk.*). Off with the door.
  const agentDesk = userVenue
    ? new AgentDesk({
        connections: agentConnectionStore,
        accounts: agentAccountStore,
        audit: new SqlAgentDeskAuditStore(sql),
        keys: createAgentKeyReader(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s),
        calls: createAgentKeyCallReader(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s),
        venue: () => userVenue.venue(),
        now: () => new Date(),
      })
    : null;
  // A person's own agent trading their venue sub-account under an allowance (J-agents-08 #3 to #7): the allowance and
  // its draws here, the agent's rules and access asked of svc-agents through its own gate. Off with the door; with
  // AGENTS_URL blank every grant and order refuses agents.policy_unavailable.
  const ownAgentTrading = userVenue
    ? new OwnAgentTrading({
        door: userVenue,
        store: new SqlAllowanceStore(sql),
        policy: env.AGENTS_URL.trim() ? createOwnAgentPolicy(env.AGENTS_URL.trim(), env.INTERNAL_SERVICE_SECRET, outS2s) : null,
        values: agentAccountValues,
        now: () => new Date(),
      })
    : null;
  return { agentAccountStore, agentAccountValues, agentAccounts, agentOrders, agentActivity, agentDesk, ownAgentTrading };
}
