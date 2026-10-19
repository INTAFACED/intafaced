package io.intafaced.fix;

import quickfix.DefaultMessageFactory;
import quickfix.FileStoreFactory;
import quickfix.MemoryStoreFactory;
import quickfix.MessageStoreFactory;
import quickfix.ScreenLogFactory;
import quickfix.SessionSettings;
import quickfix.ThreadedSocketAcceptor;

/**
 * QuickFIX/J 3.0.2 acceptor. Session only. Not a book. Not a ledger.
 * Blank store path = memory (sequences reset). Owner directory = FileStore.
 */
public final class FixAcceptor implements AutoCloseable {
    private final ThreadedSocketAcceptor acceptor;
    public final FixSessionApplication application;
    public final FixAcceptorConfig config;
    public final boolean durableStore;

    private FixAcceptor(
            ThreadedSocketAcceptor acceptor,
            FixSessionApplication application,
            FixAcceptorConfig config,
            boolean durableStore) {
        this.acceptor = acceptor;
        this.application = application;
        this.config = config;
        this.durableStore = durableStore;
    }

    public static FixAcceptor start(FixAcceptorConfig config, FixSessionApplication application) throws Exception {
        return start(config, application, "");
    }

    public static FixAcceptor start(
            FixAcceptorConfig config, FixSessionApplication application, String storePath) throws Exception {
        String path = storePath == null ? "" : storePath.trim();
        SessionSettings settings = config.toSessionSettings(path);
        MessageStoreFactory stores = path.isEmpty() ? new MemoryStoreFactory() : new FileStoreFactory(settings);
        ThreadedSocketAcceptor acceptor = new ThreadedSocketAcceptor(
                application,
                stores,
                settings,
                new ScreenLogFactory(false, false, false),
                new DefaultMessageFactory());
        acceptor.start();
        return new FixAcceptor(acceptor, application, config, !path.isEmpty());
    }

    @Override
    public void close() {
        acceptor.stop();
    }
}
