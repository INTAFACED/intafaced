package io.intafaced.fix;

import java.util.Map;

/**
 * Live QFJ acceptor. OWNER-SET env. Blank sockets refuse.
 * Drop-copy is a second session. Blank FIX_DROPCOPY_* refuses — not order-entry.
 * House-book fills hitch through HMAC ingest; blank FIX_DROPCOPY_INGEST_PORT refuses.
 * stdin adapt CLI remains FixAdapterMain.
 */
public final class FixAcceptorMain {
    public static void main(String[] args) throws Exception {
        Map<String, String> env = System.getenv();
        SessionConfigResult parsed = FixAcceptorConfig.fromOwnerEnv(env);
        if (!parsed.ok) {
            System.err.print(parsed.errorCode + ": " + parsed.errorMessage);
            System.exit(2);
            return;
        }
        SessionConfigResult dropCopy = FixDropCopyConfig.requireIndependent(env, parsed.config);
        if (!dropCopy.ok) {
            System.err.print(dropCopy.errorCode + ": " + dropCopy.errorMessage);
            System.exit(2);
            return;
        }
        DropCopyIngestConfig.Result ingest = DropCopyIngestConfig.fromOwnerEnv(env);
        if (!ingest.ok) {
            System.err.print(ingest.errorCode + ": " + ingest.errorMessage);
            System.exit(2);
            return;
        }
        ServiceKeys.Inbound s2s;
        try {
            s2s = ServiceKeys.inboundFromEnv(env, ServiceAuth.SERVICE_NAME);
        } catch (ServiceKeys.KeyError e) {
            System.err.print("s2s_unconfigured: " + e.getMessage());
            System.exit(2);
            return;
        }
        String secret = env.get(ServiceAuth.SECRET_ENV);
        if (!ServiceAuth.secretReady(secret) && (s2s == null || !s2s.keypairOnly())) {
            System.err.print(
                    "service_auth_unconfigured: INTERNAL_SERVICE_SECRET is blank; svc-fix does not accept unsigned drop-copy fills");
            System.exit(2);
            return;
        }
        MatchingSubmitPort matching = MatchingSubmitPort.fromEnv(env);
        DropCopyHub hub = new DropCopyHub();
        FixSessionApplication orderApp = new FixSessionApplication(new FixGatewayAdapter(), matching, hub);
        FixDropCopyApplication dropApp = new FixDropCopyApplication(hub);
        DropCopyIngest.Result ingestStarted =
                DropCopyIngest.start(ingest.config.port, dropCopy.config.productBegin, secret, hub, s2s);
        if (!ingestStarted.ok) {
            System.err.print(ingestStarted.errorCode + ": " + ingestStarted.errorMessage);
            System.exit(2);
            return;
        }
        FixAcceptorConfig.StoreResult orderStore = FixAcceptorConfig.storeFromEnv(env);
        if (!orderStore.ok) {
            System.err.print(orderStore.errorCode + ": " + orderStore.errorMessage);
            System.exit(2);
            return;
        }
        FixDropCopyConfig.StoreResult store = FixDropCopyConfig.storeFromEnv(env);
        if (!store.ok) {
            System.err.print(store.errorCode + ": " + store.errorMessage);
            System.exit(2);
            return;
        }
        try (FixAcceptor ignored = FixAcceptor.start(parsed.config, orderApp, orderStore.path);
                FixDropCopyAcceptor dropIgnored = FixDropCopyAcceptor.start(dropCopy.config, dropApp, store.path);
                DropCopyIngest ingestIgnored = ingestStarted.ingest) {
            Thread.currentThread().join();
        }
    }
}
