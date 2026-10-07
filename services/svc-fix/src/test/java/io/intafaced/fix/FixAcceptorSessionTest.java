package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import quickfix.ConfigError;
import quickfix.DefaultMessageFactory;
import quickfix.FileStoreFactory;
import quickfix.FixVersions;
import quickfix.MemoryStoreFactory;
import quickfix.ScreenLogFactory;
import quickfix.Session;
import quickfix.SessionID;
import quickfix.SessionSettings;
import quickfix.SocketInitiator;
import quickfix.field.ClOrdID;
import quickfix.field.MsgType;
import quickfix.field.OrdType;
import quickfix.field.OrderQty;
import quickfix.field.OrigSendingTime;
import quickfix.field.PossDupFlag;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.TestReqID;
import quickfix.field.TimeInForce;
import quickfix.field.TransactTime;
import quickfix.fix44.NewOrderSingle;
import quickfix.fix44.TestRequest;

class FixAcceptorSessionTest {

    @Test
    void officialDictionariesAreOnTheClasspath() throws Exception {
        assertNotNull(FixDictionaries.loadOfficial(FixDictionaries.FIX42_XML));
        assertNotNull(FixDictionaries.loadOfficial(FixDictionaries.FIX44_XML));
        assertNotNull(FixDictionaries.loadOfficial(FixDictionaries.FIX50_XML));
        assertNotNull(FixDictionaries.loadOfficial(FixDictionaries.FIXT11_XML));
        assertEquals(FixDictionaries.FIX42_XML, FixDictionaries.applicationResource(FixVersions.BEGINSTRING_FIX42));
        assertEquals(FixDictionaries.FIX44_XML, FixDictionaries.applicationResource(FixVersions.BEGINSTRING_FIX44));
        assertEquals(FixDictionaries.FIX50_XML, FixDictionaries.applicationResource(FixVersions.FIX50));
        assertEquals(FixVersions.BEGINSTRING_FIXT11, FixDictionaries.sessionBeginString(FixVersions.FIX50));
    }

    @Test
    void unsupportedBeginStringRefusesBeforeListen() {
        SessionConfigResult result = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX40, "INTAFACED", "CLIENT", "19000", "5", "");
        assertFalse(result.ok);
        assertEquals("unsupported_begin_string", result.errorCode);
    }

    @Test
    void blankSocketsRefuseWithoutInventingPortOrCompId() {
        SessionConfigResult port = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "", "5", "");
        assertFalse(port.ok);
        assertEquals("session_unconfigured", port.errorCode);
        assertTrue(port.errorMessage.contains("invent a listen port"));

        SessionConfigResult sender = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "", "CLIENT", "19000", "5", "");
        assertFalse(sender.ok);
        assertTrue(sender.errorMessage.contains("invent a CompID"));

        SessionConfigResult heart = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "19000", "", "");
        assertFalse(heart.ok);
        assertTrue(heart.errorMessage.contains("invent a heartbeat"));
    }

    @Test
    void certifiedWithoutRulebookRefuses() {
        SessionConfigResult result = FixAcceptorConfig.refuseCertifiedClaim("");
        assertFalse(result.ok);
        assertEquals("certified_unconfigured", result.errorCode);
        assertTrue(result.errorMessage.contains("invent a rulebook"));
        SessionConfigResult stillOps = FixAcceptorConfig.refuseCertifiedClaim("v1");
        assertFalse(stillOps.ok);
        assertEquals("certified_unconfigured", stillOps.errorCode);
    }

    @Test
    @Timeout(20)
    void fix44LogonHeartbeatLogout() throws Exception {
        Pair pair = Pair.start(FixVersions.BEGINSTRING_FIX44);
        try {
            assertTrue(pair.server.loggedOn.await(8, TimeUnit.SECONDS), "acceptor logon");
            assertTrue(pair.client.loggedOn.await(8, TimeUnit.SECONDS), "initiator logon");
            assertTrue(pair.server.adminMsgTypes().contains(MsgType.LOGON) || pair.client.adminMsgTypes().contains(MsgType.LOGON));
            Session clientSession = Session.lookupSession(pair.clientId);
            assertNotNull(clientSession);
            TestRequest probe = new TestRequest();
            probe.set(new TestReqID("hb"));
            assertTrue(clientSession.send(probe));
            Thread.sleep(400);
            pair.logout();
            assertTrue(pair.server.loggedOut.await(8, TimeUnit.SECONDS) || pair.client.loggedOut.await(2, TimeUnit.SECONDS));
        } finally {
            pair.close();
        }
    }

    @Test
    @Timeout(20)
    void fix42AndFix50SessionsLogon() throws Exception {
        for (String begin : List.of(FixVersions.BEGINSTRING_FIX42, FixVersions.FIX50)) {
            Pair pair = Pair.start(begin);
            try {
                assertTrue(pair.server.loggedOn.await(8, TimeUnit.SECONDS), begin + " acceptor logon");
                assertTrue(pair.client.loggedOn.await(8, TimeUnit.SECONDS), begin + " initiator logon");
            } finally {
                pair.close();
            }
        }
    }

    @Test
    @Timeout(20)
    void sequenceGapProducesResendRequest() throws Exception {
        Pair pair = Pair.start(FixVersions.BEGINSTRING_FIX44);
        try {
            assertTrue(pair.server.loggedOn.await(8, TimeUnit.SECONDS));
            assertTrue(pair.client.loggedOn.await(8, TimeUnit.SECONDS));
            Session clientSession = Session.lookupSession(pair.clientId);
            int next = clientSession.getExpectedSenderNum();
            clientSession.setNextSenderMsgSeqNum(next + 3);
            TestRequest probe = new TestRequest();
            probe.set(new TestReqID("gap"));
            assertTrue(clientSession.send(probe));
            boolean resend = false;
            for (int i = 0; i < 40; i++) {
                if (pair.server.adminMsgTypes().contains(MsgType.RESEND_REQUEST)
                        || pair.client.adminMsgTypes().contains(MsgType.RESEND_REQUEST)
                        || pair.server.adminMsgTypes().contains("to:" + MsgType.RESEND_REQUEST)) {
                    resend = true;
                    break;
                }
                Thread.sleep(50);
            }
            assertTrue(resend, "admin types server=" + pair.server.adminMsgTypes() + " client=" + pair.client.adminMsgTypes());
        } finally {
            pair.close();
        }
    }

    @Test
    @Timeout(20)
    void newOrderSingleDoesNotPostMatching() throws Exception {
        Pair pair = Pair.start(FixVersions.BEGINSTRING_FIX44);
        try {
            assertTrue(pair.server.loggedOn.await(8, TimeUnit.SECONDS));
            assertTrue(pair.client.loggedOn.await(8, TimeUnit.SECONDS));
            Session clientSession = Session.lookupSession(pair.clientId);
            NewOrderSingle nos = new NewOrderSingle();
            nos.set(new ClOrdID("c1-not-c2"));
            nos.set(new Symbol("BTC/USDT"));
            nos.set(new Side(Side.BUY));
            nos.set(new OrdType(OrdType.LIMIT));
            nos.setString(OrderQty.FIELD, "1.00");
            nos.setString(quickfix.field.Price.FIELD, "100.25");
            nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
            nos.set(new TransactTime());
            assertTrue(clientSession.send(nos));
            for (int i = 0; i < 20 && pair.server.appMsgTypes().isEmpty(); i++) {
                Thread.sleep(50);
            }
            assertEquals(0, pair.server.matchingPosts());
            assertFalse(pair.server.appMsgTypes().isEmpty(), "NOS reached fromApp");
        } finally {
            pair.close();
        }
    }

    @Test
    void blankOrderEntryStorePathResetsAndDoesNotInventADirectory() throws Exception {
        SessionConfigResult parsed = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "19000", "5", "");
        assertTrue(parsed.ok, parsed.errorMessage);

        for (String blank : new String[] {null, "", "   "}) {
            SessionSettings memory = parsed.config.toSessionSettings(blank);
            assertEquals("Y", memory.getString("ResetOnLogon"));
            assertEquals("Y", memory.getString("ResetOnLogout"));
            assertEquals("Y", memory.getString("ResetOnDisconnect"));
            assertFalse(hasSetting(memory, "FileStorePath"), "blank store path must not mint FileStorePath");
        }

        SessionSettings noArg = parsed.config.toSessionSettings();
        assertEquals("Y", noArg.getString("ResetOnLogon"));
        assertFalse(hasSetting(noArg, "FileStorePath"));

        FixAcceptorConfig.StoreResult empty = FixAcceptorConfig.storeFromEnv(Map.of());
        assertTrue(empty.ok);
        assertFalse(empty.durable);
        assertEquals("", empty.path);

        FixAcceptorConfig.StoreResult spaces =
                FixAcceptorConfig.storeFromEnv(Map.of(FixAcceptorConfig.STORE_PATH_ENV, "  "));
        assertTrue(spaces.ok);
        assertEquals("", spaces.path);

        Path missing = Path.of("/no/such/intafaced-order-entry-store");
        assertFalse(Files.exists(missing));
        FixAcceptorConfig.StoreResult refused = FixAcceptorConfig.storeFromEnv(
                Map.of(FixAcceptorConfig.STORE_PATH_ENV, missing.toString()));
        assertFalse(refused.ok);
        assertEquals(FixAcceptorConfig.STORE_UNCONFIGURED, refused.errorCode);
        assertTrue(refused.errorMessage.contains("does not invent an order-entry store"));
        assertFalse(Files.exists(missing));
    }

    @Test
    void orderEntryStorePathDisablesResetAndUsesFileStore() throws Exception {
        Path dir = Files.createTempDirectory("oe-store-");
        SessionConfigResult parsed = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "19000", "5", "");
        assertTrue(parsed.ok, parsed.errorMessage);
        SessionSettings durable = parsed.config.toSessionSettings(dir.toString());
        assertEquals("N", durable.getString("ResetOnLogon"));
        assertEquals("N", durable.getString("ResetOnLogout"));
        assertEquals("N", durable.getString("ResetOnDisconnect"));
        assertEquals("Y", durable.getString("PersistMessages"));
        assertEquals(dir.toString(), durable.getString("FileStorePath"));

        FixAcceptorConfig.StoreResult stored = FixAcceptorConfig.storeFromEnv(
                Map.of(FixAcceptorConfig.STORE_PATH_ENV, dir.toString()));
        assertTrue(stored.ok);
        assertTrue(stored.durable);
        assertEquals(dir.toAbsolutePath().toString(), stored.path);

        FixSessionApplication app = new FixSessionApplication();
        try (FixAcceptor acceptor = FixAcceptor.start(parsed.config, app, dir.toString())) {
            assertTrue(acceptor.durableStore);
        }
    }

    @Test
    @Timeout(40)
    void replayedNewOrderSingleIsNotANewOrderWhenStoreRememberedSequence() throws Exception {
        Path acceptorStore = Files.createTempDirectory("oe-acceptor-store-");
        Path initiatorStore = Files.createTempDirectory("oe-initiator-store-");
        int port = freePort();
        String begin = FixVersions.BEGINSTRING_FIX44;
        String sender = "OEENTRY";
        String target = "OECLIENT";
        SessionConfigResult parsed = FixAcceptorConfig.fromOwner(
                begin, sender, target, Integer.toString(port), "30", "");
        assertTrue(parsed.ok, parsed.errorMessage);

        AtomicInteger firstPosts = new AtomicInteger();
        FixSessionApplication firstApp = application(firstPosts, target);
        FixAcceptor firstAcceptor = FixAcceptor.start(parsed.config, firstApp, acceptorStore.toString());
        assertTrue(firstAcceptor.durableStore);
        SocketInitiator firstInitiator = null;
        int nosSeq;
        try {
            firstInitiator = startDurableInitiator(begin, port, initiatorStore, sender, target);
            SessionID clientId = new SessionID(begin, target, sender);
            assertTrue(firstApp.loggedOn.await(8, TimeUnit.SECONDS), "first logon");
            Session client = loggedOnSession(clientId);
            nosSeq = client.getExpectedSenderNum();
            assertTrue(client.send(limitNos()), "first NOS while loggedOn=" + client.isLoggedOn());
            assertEquals(nosSeq, client.getExpectedSenderNum() - 1, "send used the session sequence");
            for (int i = 0; i < 40 && firstPosts.get() < 1; i++) {
                Thread.sleep(50);
            }
            assertEquals(1, firstPosts.get());
            assertEquals(1, firstApp.matchingPosts());
        } finally {
            stopQuietly(firstInitiator);
            firstAcceptor.close();
        }

        int rememberedTarget = readTargetSeq(acceptorStore);
        assertTrue(rememberedTarget > nosSeq, "store remembered target " + rememberedTarget + " nos " + nosSeq);

        awaitPortFree(port);
        AtomicInteger replayPosts = new AtomicInteger();
        FixSessionApplication replayApp = application(replayPosts, target);
        FixAcceptor replayAcceptor = FixAcceptor.start(parsed.config, replayApp, acceptorStore.toString());
        SocketInitiator replayInitiator = null;
        try {
            replayInitiator = startDurableInitiator(begin, port, initiatorStore, sender, target);
            SessionID clientId = new SessionID(begin, target, sender);
            assertTrue(replayApp.loggedOn.await(8, TimeUnit.SECONDS), "replay logon");
            Session acceptorSession = loggedOnSession(new SessionID(begin, sender, target));
            assertTrue(
                    acceptorSession.getExpectedTargetNum() > nosSeq,
                    "loaded target " + acceptorSession.getExpectedTargetNum() + " forgot " + nosSeq);
            Session client = loggedOnSession(clientId);
            client.setNextSenderMsgSeqNum(nosSeq);
            NewOrderSingle replay = limitNos();
            replay.getHeader().setBoolean(PossDupFlag.FIELD, true);
            replay.getHeader().setUtcTimeStamp(
                    OrigSendingTime.FIELD, LocalDateTime.now(ZoneOffset.UTC).minusSeconds(2), true);
            client.send(replay);
            Thread.sleep(600);
            assertEquals(0, replayPosts.get(), "replayed NOS was treated as a new order");
            assertEquals(0, replayApp.matchingPosts());
        } finally {
            stopQuietly(replayInitiator);
            replayAcceptor.close();
        }
    }

    private static boolean hasSetting(SessionSettings settings, String key) {
        try {
            settings.getString(key);
            return true;
        } catch (ConfigError missing) {
            return false;
        }
    }

    private static Session loggedOnSession(SessionID sessionId) throws Exception {
        Session session = null;
        for (int i = 0; i < 40; i++) {
            session = Session.lookupSession(sessionId);
            if (session != null && session.isLoggedOn()) {
                return session;
            }
            Thread.sleep(50);
        }
        assertNotNull(session, "missing session " + sessionId);
        assertTrue(session.isLoggedOn(), "session not logged on " + sessionId);
        return session;
    }

    private static FixSessionApplication application(AtomicInteger posts, String senderCompId) {
        MatchingSubmitPort matching = new MatchingSubmitPort(
                "http://matching.example",
                "{\"" + senderCompId + "\":\"acct-desk\"}",
                "a".repeat(32),
                (url, json, headers) -> {
                    posts.incrementAndGet();
                    return new MatchingSubmitPort.Transport.Response(
                            200, "{\"accepted\":true,\"sequence\":9}");
                });
        return new FixSessionApplication(new FixGatewayAdapter(), matching);
    }

    private static NewOrderSingle limitNos() {
        NewOrderSingle nos = new NewOrderSingle();
        nos.set(new ClOrdID("replay-clid"));
        nos.set(new Symbol("BTC/USDT"));
        nos.set(new Side(Side.BUY));
        nos.set(new OrdType(OrdType.LIMIT));
        nos.setString(OrderQty.FIELD, "1.00");
        nos.setString(quickfix.field.Price.FIELD, "100.25");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        nos.set(new TransactTime());
        return nos;
    }

    private static SocketInitiator startDurableInitiator(
            String productBegin, int port, Path store, String acceptorCompId, String clientCompId) throws Exception {
        String sessionBegin = FixDictionaries.sessionBeginString(productBegin);
        String appDd = FixDictionaries.applicationResource(productBegin);
        StringBuilder text = new StringBuilder();
        text.append("[DEFAULT]\n");
        text.append("ConnectionType=initiator\n");
        text.append("HeartBtInt=30\n");
        text.append("StartTime=00:00:00\n");
        text.append("EndTime=00:00:00\n");
        text.append("UseDataDictionary=Y\n");
        text.append("TimeZone=UTC\n");
        text.append("ResetOnLogon=N\n");
        text.append("ResetOnLogout=N\n");
        text.append("ResetOnDisconnect=N\n");
        text.append("PersistMessages=Y\n");
        text.append("FileStorePath=").append(store.toAbsolutePath()).append('\n');
        text.append("SocketConnectHost=127.0.0.1\n");
        text.append("SocketConnectPort=").append(port).append('\n');
        text.append("ReconnectInterval=2\n");
        text.append("[SESSION]\n");
        text.append("BeginString=").append(sessionBegin).append('\n');
        text.append("SenderCompID=").append(clientCompId).append('\n');
        text.append("TargetCompID=").append(acceptorCompId).append('\n');
        text.append("DataDictionary=").append(appDd).append('\n');
        SessionSettings settings =
                new SessionSettings(new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
        SocketInitiator initiator = new SocketInitiator(
                new FixSessionApplication(),
                new FileStoreFactory(settings),
                settings,
                new ScreenLogFactory(false, false, false),
                new DefaultMessageFactory());
        initiator.start();
        return initiator;
    }

    private static int readTargetSeq(Path dir) throws Exception {
        Path seqFile;
        try (var files = Files.list(dir)) {
            seqFile = files.filter(path -> path.getFileName().toString().endsWith(".targetseqnums")).findFirst().orElse(null);
        }
        assertNotNull(seqFile, "store wrote no target sequence in " + dir);
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(Files.readAllBytes(seqFile)))) {
            return Integer.parseInt(in.readUTF().trim());
        }
    }

    private static void stopQuietly(SocketInitiator initiator) {
        if (initiator == null) {
            return;
        }
        try {
            initiator.stop();
        } catch (RuntimeException ignored) {
            // stop anyway
        }
    }

    private static void awaitPortFree(int port) throws Exception {
        for (int i = 0; i < 50; i++) {
            try (ServerSocket socket = new ServerSocket()) {
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress("127.0.0.1", port));
                return;
            } catch (IOException busy) {
                Thread.sleep(100);
            }
        }
        throw new AssertionError("port " + port + " stayed bound");
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        }
    }

    private static final class Pair implements AutoCloseable {
        final FixAcceptor acceptor;
        final SocketInitiator initiator;
        final FixSessionApplication server;
        final FixSessionApplication client;
        final SessionID clientId;

        private Pair(
                FixAcceptor acceptor,
                SocketInitiator initiator,
                FixSessionApplication server,
                FixSessionApplication client,
                SessionID clientId) {
            this.acceptor = acceptor;
            this.initiator = initiator;
            this.server = server;
            this.client = client;
            this.clientId = clientId;
        }

        static Pair start(String productBegin) throws Exception {
            int port = freePort();
            SessionConfigResult parsed = FixAcceptorConfig.fromOwner(
                    productBegin, "INTAFACED", "CLIENT", Integer.toString(port), "5", "");
            assertTrue(parsed.ok, parsed.errorMessage);
            FixSessionApplication server = new FixSessionApplication();
            FixAcceptor acceptor = FixAcceptor.start(parsed.config, server);
            FixSessionApplication clientApp = new FixSessionApplication();
            String sessionBegin = FixDictionaries.sessionBeginString(productBegin);
            String appDd = FixDictionaries.applicationResource(productBegin);
            String transportDd = FixDictionaries.transportResource(productBegin);
            StringBuilder text = new StringBuilder();
            text.append("[DEFAULT]\n");
            text.append("ConnectionType=initiator\n");
            text.append("HeartBtInt=5\n");
            text.append("StartTime=00:00:00\n");
            text.append("EndTime=00:00:00\n");
            text.append("UseDataDictionary=Y\n");
            text.append("TimeZone=UTC\n");
            text.append("ResetOnLogon=Y\n");
            text.append("ResetOnLogout=Y\n");
            text.append("ResetOnDisconnect=Y\n");
            text.append("SocketConnectHost=127.0.0.1\n");
            text.append("SocketConnectPort=").append(port).append('\n');
            text.append("ReconnectInterval=2\n");
            text.append("[SESSION]\n");
            text.append("BeginString=").append(sessionBegin).append('\n');
            text.append("SenderCompID=CLIENT\n");
            text.append("TargetCompID=INTAFACED\n");
            if (FixVersions.BEGINSTRING_FIXT11.equals(sessionBegin)) {
                text.append("DefaultApplVerID=7\n");
                text.append("TransportDataDictionary=").append(transportDd).append('\n');
                text.append("AppDataDictionary=").append(appDd).append('\n');
            } else {
                text.append("DataDictionary=").append(appDd).append('\n');
            }
            SessionSettings initiatorSettings = new SessionSettings(
                    new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
            SocketInitiator initiator = new SocketInitiator(
                    clientApp,
                    new MemoryStoreFactory(),
                    initiatorSettings,
                    new ScreenLogFactory(false, false, false),
                    new DefaultMessageFactory());
            initiator.start();
            SessionID clientId = new SessionID(sessionBegin, "CLIENT", "INTAFACED");
            return new Pair(acceptor, initiator, server, clientApp, clientId);
        }

        void logout() {
            Session session = Session.lookupSession(clientId);
            if (session != null) {
                session.logout("c1 done");
            }
        }

        @Override
        public void close() {
            try {
                logout();
            } catch (RuntimeException ignored) {
                // stop anyway
            }
            initiator.stop();
            acceptor.close();
        }

        static int freePort() throws Exception {
            try (ServerSocket socket = new ServerSocket(0)) {
                socket.setReuseAddress(true);
                return socket.getLocalPort();
            }
        }
    }
}
