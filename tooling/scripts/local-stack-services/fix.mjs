/**
 * svc-fix, the FIX adapter (Java, QuickFIX/J), with LOCAL TEST sessions (J-cex-spot-20 #3): one order-entry session and
 * one drop-copy session on loopback ports, and a CompID map with one labelled TEST counterparty. These are this stack's
 * own TEST values, never the owner's CompIDs, ports or accounts; no counterparty logs on here, so both sessions read
 * "Not logged on" and no FIX order reaches matching. The founder console reads the adapter's own status through
 * svc-edge, signed with the dedicated read key both sides get from this stack's secrets.
 */
export const FIX_TEST_SESSIONS = Object.freeze({
  orderEntry: { sender: 'INTAFACED-TEST', target: 'TEST-CLIENT' },
  dropCopy: { sender: 'INTAFACED-TEST-DC', target: 'TEST-CLIENT-DC' },
  // LOCAL TEST: the TEST counterparty's orders would submit as this labelled account. No account by this id holds funds.
  compIdAccounts: { 'TEST-CLIENT': 'TEST-fix-account' },
});

export default ({ c, secrets, urlOf, PORTS }) => ({
  name: 'fix',
  java: { main: 'io.intafaced.fix.FixAcceptorMain' },
  env: () => {
    // svc-fix holds no database and no bus; the fleet secret signs its matching submits and verifies drop-copy fills.
    const shared = c('svc-fix', PORTS.fix);
    for (const key of ['DATABASE_URL', 'NATS_URL', 'EDGE_PRINCIPAL_SECRET', 'JWT_ACCESS_SECRET']) delete shared[key];
    return {
      ...shared,
      FIX_BEGIN_STRING: 'FIX.4.4',
      FIX_SENDER_COMP_ID: FIX_TEST_SESSIONS.orderEntry.sender,
      FIX_TARGET_COMP_ID: FIX_TEST_SESSIONS.orderEntry.target,
      FIX_SOCKET_ACCEPT_PORT: String(PORTS.fixOrderEntry),
      FIX_HEARTBTINT: '30',
      FIX_DROPCOPY_BEGIN_STRING: 'FIX.4.4',
      FIX_DROPCOPY_SENDER_COMP_ID: FIX_TEST_SESSIONS.dropCopy.sender,
      FIX_DROPCOPY_TARGET_COMP_ID: FIX_TEST_SESSIONS.dropCopy.target,
      FIX_DROPCOPY_SOCKET_ACCEPT_PORT: String(PORTS.fixDropCopy),
      FIX_DROPCOPY_HEARTBTINT: '30',
      // The ingest listener also serves /health and the adapter status (AdapterStatus.java).
      FIX_DROPCOPY_INGEST_PORT: String(PORTS.fix),
      MATCHING_BASE_URL: urlOf('matching'),
      FIX_COMPID_ACCOUNT_JSON: JSON.stringify(FIX_TEST_SESSIONS.compIdAccounts),
      FIX_STATUS_READ_SECRET: secrets.fixStatusRead,
    };
  },
});
