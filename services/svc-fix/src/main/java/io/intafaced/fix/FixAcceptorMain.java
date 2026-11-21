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
        Started started = start(System.getenv());
        if (!started.ok) {
            System.err.print(started.errorCode + ": " + started.errorMessage);
            System.exit(2);
            return;
        }
        try (Running ignored = started.running) {
            Thread.currentThread().join();
        }
    }

    /**
     * Builds and starts svc-fix from its environment, the one composition the process runs: the order-entry and
     * drop-copy acceptors, the drop-copy ingest listener, and the adapter's health and status on that listener. A
     * setting that refuses returns its code and message, with nothing left running.
     */
    public static Started start(Map<String, String> env) throws Exception {
        SessionConfigResult parsed = FixAcceptorConfig.fromOwnerEnv(env);
        if (!parsed.ok) {
            return Started.refuse(parsed.errorCode, parsed.errorMessage);
        }
        SessionConfigResult dropCopy = FixDropCopyConfig.requireIndependent(env, parsed.config);
        if (!dropCopy.ok) {
            return Started.refuse(dropCopy.errorCode, dropCopy.errorMessage);
        }
        DropCopyIngestConfig.Result ingest = DropCopyIngestConfig.fromOwnerEnv(env);
        if (!ingest.ok) {
            return Started.refuse(ingest.errorCode, ingest.errorMessage);
        }
        ServiceKeys.Inbound s2s;
        try {
            s2s = ServiceKeys.inboundFromEnv(env, ServiceAuth.SERVICE_NAME);
        } catch (ServiceKeys.KeyError e) {
            return Started.refuse("s2s_unconfigured", e.getMessage());
        }
        String secret = env.get(ServiceAuth.SECRET_ENV);
        if (!ServiceAuth.secretReady(secret) && (s2s == null || !s2s.keypairOnly())) {
            return Started.refuse(
                    "service_auth_unconfigured",
                    "INTERNAL_SERVICE_SECRET is blank; svc-fix does not accept unsigned drop-copy fills");
        }
        MatchingSubmitPort matching;
        try {
            matching = MatchingSubmitPort.fromEnv(env);
        } catch (ServiceKeys.KeyError e) {
            return Started.refuse("s2s_unconfigured", e.getMessage());
        }
        DropCopyHub hub = new DropCopyHub();
        FixSessionApplication orderApp = new FixSessionApplication(new FixGatewayAdapter(), matching, hub);
        FixDropCopyApplication dropApp = new FixDropCopyApplication(hub);
        DropCopyIngest.Result ingestStarted =
                DropCopyIngest.start(ingest.config.port, dropCopy.config.productBegin, secret, hub, s2s);
        if (!ingestStarted.ok) {
            return Started.refuse(ingestStarted.errorCode, ingestStarted.errorMessage);
        }
        DropCopyIngest listener = ingestStarted.ingest;
        FixAcceptor orderEntry = null;
        FixDropCopyAcceptor dropAcceptor = null;
        try {
            FixAcceptorConfig.StoreResult orderStore = FixAcceptorConfig.storeFromEnv(env);
            if (!orderStore.ok) {
                listener.close();
                return Started.refuse(orderStore.errorCode, orderStore.errorMessage);
            }
            FixDropCopyConfig.StoreResult store = FixDropCopyConfig.storeFromEnv(env);
            if (!store.ok) {
                listener.close();
                return Started.refuse(store.errorCode, store.errorMessage);
            }
            orderEntry = FixAcceptor.start(parsed.config, orderApp, orderStore.path);
            dropAcceptor = FixDropCopyAcceptor.start(dropCopy.config, dropApp, store.path);
            // The adapter's own status on the ingest listener: its sessions and the CompID map it submits with.
            Map<String, String> compIdAccounts =
                    MatchingSubmitPort.readCompIdAccountMap(env.get(MatchingSubmitPort.COMPID_ACCOUNT_JSON_ENV));
            FixAcceptor orderSessions = orderEntry;
            FixDropCopyAcceptor dropSessions = dropAcceptor;
            listener.mount(AdapterStatus.HEALTH_PATH, AdapterStatus.health());
            listener.mount(
                    AdapterStatus.PATH,
                    AdapterStatus.handler(
                            () -> {
                                java.util.List<AdapterStatus.SessionRow> rows = new java.util.ArrayList<>(
                                        AdapterStatus.rows(AdapterStatus.ORDER_ENTRY, orderSessions.sessions(), compIdAccounts));
                                rows.addAll(AdapterStatus.rows(AdapterStatus.DROP_COPY, dropSessions.sessions(), null));
                                return AdapterStatus.json(rows, compIdAccounts, java.time.Instant.now());
                            },
                            env.get(AdapterStatus.SECRET_ENV),
                            s2s));
            return Started.ok(new Running(orderEntry, dropAcceptor, listener));
        } catch (Exception | Error e) {
            listener.close();
            if (dropAcceptor != null) {
                dropAcceptor.close();
            }
            if (orderEntry != null) {
                orderEntry.close();
            }
            throw e;
        }
    }

    /** What {@link #start} returns: a running svc-fix, or the code and message of the setting that refused. */
    public static final class Started {
        public final boolean ok;
        public final Running running;
        public final String errorCode;
        public final String errorMessage;

        private Started(boolean ok, Running running, String errorCode, String errorMessage) {
            this.ok = ok;
            this.running = running;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static Started ok(Running running) {
            return new Started(true, running, null, null);
        }

        static Started refuse(String code, String message) {
            return new Started(false, null, code, message);
        }
    }

    /** A running svc-fix. Closing it stops the listener, then the drop-copy acceptor, then the order-entry one. */
    public static final class Running implements AutoCloseable {
        private final FixAcceptor orderEntry;
        private final FixDropCopyAcceptor dropCopy;
        private final DropCopyIngest listener;

        Running(FixAcceptor orderEntry, FixDropCopyAcceptor dropCopy, DropCopyIngest listener) {
            this.orderEntry = orderEntry;
            this.dropCopy = dropCopy;
            this.listener = listener;
        }

        /** The HTTP port of the ingest listener, which also serves the health and the status. */
        public int httpPort() {
            return listener.port();
        }

        @Override
        public void close() {
            try {
                listener.close();
            } finally {
                try {
                    dropCopy.close();
                } finally {
                    orderEntry.close();
                }
            }
        }
    }
}
