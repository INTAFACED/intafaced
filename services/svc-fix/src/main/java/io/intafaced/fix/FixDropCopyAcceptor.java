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
        String path = storePath == null ? "" : storePath.trim();
        SessionSettings settings = config.toDropCopySessionSettings(path);
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

    @Override
    public void close() {
        acceptor.stop();
    }
}
