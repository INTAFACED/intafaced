package io.intafaced.fix;

import quickfix.DefaultMessageFactory;
import quickfix.FileStoreFactory;
import quickfix.MemoryStoreFactory;
import quickfix.MessageStoreFactory;
import quickfix.ScreenLogFactory;
import quickfix.SessionSettings;
import quickfix.ThreadedSocketAcceptor;

/**
 * Named drop-copy QFJ 3.0.2 acceptor. Not the order-entry session. Not a ledger.
 * Blank store path = memory (no replay after restart). Owner directory = FileStore.
 */
public final class FixDropCopyAcceptor implements AutoCloseable {
    private final ThreadedSocketAcceptor acceptor;
    public final FixDropCopyApplication application;
    public final FixAcceptorConfig config;
    public final boolean durableStore;

    private FixDropCopyAcceptor(
            ThreadedSocketAcceptor acceptor,
            FixDropCopyApplication application,
            FixAcceptorConfig config,
            boolean durableStore) {
        this.acceptor = acceptor;
        this.application = application;
        this.config = config;
        this.durableStore = durableStore;
    }

    public static FixDropCopyAcceptor start(FixAcceptorConfig config, FixDropCopyApplication application)
            throws Exception {
        return start(config, application, "");
    }

    public static FixDropCopyAcceptor start(
            FixAcceptorConfig config, FixDropCopyApplication application, String storePath) throws Exception {
        return start(config, application, storePath, "");
    }

    /** As above, accepting on {@code host} only; a blank host accepts on every interface. */
    public static FixDropCopyAcceptor start(
            FixAcceptorConfig config, FixDropCopyApplication application, String storePath, String host) throws Exception {
        String path = storePath == null ? "" : storePath.trim();
        SessionSettings settings = config.toDropCopySessionSettings(path);
        if (host != null && !host.isBlank()) {
            settings.setString(quickfix.Acceptor.SETTING_SOCKET_ACCEPT_ADDRESS, host.trim());
        }
        MessageStoreFactory stores = path.isEmpty() ? new MemoryStoreFactory() : new FileStoreFactory(settings);
        ThreadedSocketAcceptor acceptor = new ThreadedSocketAcceptor(
                application,
                stores,
                settings,
                new ScreenLogFactory(false, false, false),
                new DefaultMessageFactory());
        acceptor.start();
        return new FixDropCopyAcceptor(acceptor, application, config, !path.isEmpty());
    }

    /** The sessions this acceptor holds, as QuickFIX/J configured them. */
    public java.util.List<quickfix.SessionID> sessions() {
        return acceptor.getSessions();
    }

    /** The addresses this acceptor's sockets are bound to. */
    public java.util.List<java.net.SocketAddress> listenAddresses() {
        java.util.List<java.net.SocketAddress> out = new java.util.ArrayList<>();
        for (org.apache.mina.core.service.IoAcceptor endpoint : acceptor.getEndpoints()) {
            out.addAll(endpoint.getLocalAddresses());
        }
        return out;
    }

    @Override
    public void close() {
        acceptor.stop();
    }
}
