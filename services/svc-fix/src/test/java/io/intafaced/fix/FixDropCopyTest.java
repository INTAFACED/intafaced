package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import quickfix.ApplicationAdapter;
import quickfix.ConfigError;
import quickfix.DefaultMessageFactory;
import quickfix.FieldNotFound;
import quickfix.FixVersions;
import quickfix.MemoryStoreFactory;
import quickfix.Message;
import quickfix.ScreenLogFactory;
import quickfix.Session;
import quickfix.SessionID;
import quickfix.SessionSettings;
import quickfix.SocketInitiator;
import quickfix.field.ClOrdID;
import quickfix.field.ExecID;
import quickfix.field.MsgSeqNum;
import quickfix.field.MsgType;
import quickfix.field.OrdType;
import quickfix.field.OrderQty;
import quickfix.field.Price;
import quickfix.field.SenderCompID;
import quickfix.field.SendingTime;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.TargetCompID;
import quickfix.field.TimeInForce;
import quickfix.field.TransactTime;
import quickfix.fix44.NewOrderSingle;

class FixDropCopyTest {
    @Test
    void completenessRefusesAndListsIncludedSources() {
        DropCopyCompleteness claim = DropCopyCatalog.claimComplete();
        assertFalse(claim.complete);
        assertEquals("dropcopy_incomplete", claim.errorCode);
        assertEquals(List.of(), claim.included);
        assertTrue(claim.errorMessage.contains("included=[]"));
        assertTrue(claim.errorMessage.contains("ui"));
        assertTrue(claim.errorMessage.contains("rest"));
        assertTrue(claim.errorMessage.contains("ws"));
        assertTrue(claim.errorMessage.contains("fix"));
        assertTrue(claim.errorMessage.contains("algo"));
        assertTrue(claim.errorMessage.contains("liquidation"));
        assertTrue(claim.errorMessage.contains("rfq"));
        assertTrue(claim.errorMessage.contains("broker"));
        assertTrue(claim.toJson().contains("\"included\":[]"));
        assertFalse(claim.toJson().contains("complete\":true"));
        assertFalse(claim.errorMessage.toLowerCase().contains("certified"));
    }

    @Test
    void claimCompleteStaysRefuseUntilRequiredSourcesPublish() {
        DropCopyHub hub = new DropCopyHub();
        FixDropCopyApplication drop = new FixDropCopyApplication(hub);
        assertEquals(List.of(), drop.includedSources());
        DropCopyCompleteness before = drop.claimComplete();
        assertFalse(before.complete);
        assertEquals("dropcopy_incomplete", before.errorCode);
        assertEquals(List.of(), before.included);

        Message er = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid", FixVersions.BEGINSTRING_FIX44, null, "BTC/USDT", "buy", "limit", "1.50", "100.25", "CLIENT", "GTC"),
                new MatchingAck(true, 4L));
        assertTrue(hub.publish(DropCopyCatalog.FIX, er).ok);
        assertEquals(List.of(DropCopyCatalog.FIX), drop.includedSources());

        DropCopyCompleteness afterFix = drop.claimComplete();
        assertFalse(afterFix.complete);
        assertEquals("dropcopy_incomplete", afterFix.errorCode);
        assertEquals(List.of(DropCopyCatalog.FIX), afterFix.included);
        assertTrue(afterFix.errorMessage.contains("included=[fix]"));
        assertTrue(afterFix.toJson().contains("\"included\":[\"fix\"]"));
        assertFalse(afterFix.toJson().contains("complete\":true"));

        DropCopyPublishResult ui = hub.publish(DropCopyCatalog.UI, er);
        assertFalse(ui.ok);
        assertEquals("dropcopy_source_missing", ui.errorCode);

        assertTrue(hub.publish(DropCopyCatalog.REST, er).ok);
        DropCopyCompleteness afterRest = drop.claimComplete();
        assertFalse(afterRest.complete);
        assertEquals(List.of(DropCopyCatalog.REST, DropCopyCatalog.FIX), afterRest.included);
        assertTrue(afterRest.missing.contains(DropCopyCatalog.UI));

        for (String source : DropCopyCatalog.STREAMABLE) {
            DropCopyPublishResult streamed = hub.publish(source, er);
            assertTrue(streamed.ok, source);
        }
        DropCopyCompleteness hitchable = drop.claimComplete();
        assertFalse(hitchable.complete, "ui stays FRONTEND and is not synthesized");
        assertEquals(List.of(DropCopyCatalog.UI), hitchable.missing);
        assertFalse(DropCopyCatalog.STREAMABLE.contains(DropCopyCatalog.UI));

        DropCopyCompleteness stuffed = DropCopyCatalog.claimComplete(DropCopyCatalog.REQUIRED);
        assertFalse(stuffed.complete, "naming every source is not a publish");
        assertEquals("dropcopy_incomplete", stuffed.errorCode);
        assertTrue(stuffed.missing.contains(DropCopyCatalog.UI));
        assertFalse(stuffed.included.contains(DropCopyCatalog.UI));
        assertFalse(DropCopyCatalog.STREAMABLE.containsAll(DropCopyCatalog.REQUIRED));
    }

    @Test
    void blankDropCopyIngestPortRefusesWithoutInventingListenPort() {
        DropCopyIngestConfig.Result blank = DropCopyIngestConfig.fromOwner("");
        assertFalse(blank.ok);
        assertEquals(DropCopyIngestConfig.UNCONFIGURED, blank.errorCode);
        assertTrue(blank.errorMessage.contains("FIX_DROPCOPY_INGEST_PORT"));
        assertTrue(blank.errorMessage.contains("invent a listen port"));

        DropCopyIngest.Result unsigned = DropCopyIngest.start(19002, FixVersions.BEGINSTRING_FIX44, "", new DropCopyHub());
        assertFalse(unsigned.ok);
        assertEquals("service_auth_unconfigured", unsigned.errorCode);
        assertTrue(unsigned.errorMessage.contains("INTERNAL_SERVICE_SECRET"));
    }

    @Test
    void blankStorePathStaysMemoryAndDoesNotInventADirectory() throws Exception {
        SessionConfigResult parsed = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", "19001", "5");
        assertTrue(parsed.ok, parsed.errorMessage);
        SessionSettings memory = parsed.config.toDropCopySessionSettings("");
        assertEquals("Y", memory.getString("ResetOnLogon"));
        boolean fileStore = true;
        try {
            memory.getString("FileStorePath");
        } catch (ConfigError missing) {
            fileStore = false;
        }
        assertFalse(fileStore, "blank store path must not mint FileStorePath");

        FixDropCopyConfig.StoreResult blank = FixDropCopyConfig.storeFromEnv(Map.of());
        assertTrue(blank.ok);
        assertFalse(blank.durable);
        assertEquals("", blank.path);

        FixDropCopyConfig.StoreResult missingDir = FixDropCopyConfig.storeFromEnv(
                Map.of(FixDropCopyConfig.STORE_PATH_ENV, "/no/such/intafaced-dropcopy-store"));
        assertFalse(missingDir.ok);
        assertEquals(FixDropCopyConfig.STORE_UNCONFIGURED, missingDir.errorCode);
        assertTrue(missingDir.errorMessage.contains("does not invent a drop-copy store"));
    }

    @Test
    void ownerStoreDirectoryDisablesResetAndUsesFileStore() throws Exception {
        Path dir = Files.createTempDirectory("dropcopy-store-");
        SessionConfigResult parsed = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", "19001", "5");
        assertTrue(parsed.ok, parsed.errorMessage);
        SessionSettings durable = parsed.config.toDropCopySessionSettings(dir.toString());
        assertEquals("N", durable.getString("ResetOnLogon"));
        assertEquals("N", durable.getString("ResetOnLogout"));
        assertEquals("N", durable.getString("ResetOnDisconnect"));
        assertEquals("Y", durable.getString("PersistMessages"));
        assertEquals(dir.toString(), durable.getString("FileStorePath"));

        SessionSettings orderEntry = parsed.config.toSessionSettings();
        assertEquals("Y", orderEntry.getString("ResetOnLogon"));
        boolean oeFile = true;
        try {
            orderEntry.getString("FileStorePath");
        } catch (ConfigError missing) {
            oeFile = false;
        }
        assertFalse(oeFile, "order-entry must not inherit drop-copy FileStorePath");

        FixDropCopyApplication app = new FixDropCopyApplication();
        try (FixDropCopyAcceptor acceptor = FixDropCopyAcceptor.start(parsed.config, app, dir.toString())) {
            assertTrue(acceptor.durableStore);
        }

        String main = Files.readString(Path.of("src/main/java/io/intafaced/fix/FixAcceptorMain.java"));
        assertTrue(main.contains("FixDropCopyConfig.storeFromEnv"));
        assertTrue(main.contains("FixDropCopyAcceptor.start(dropCopy.config, dropApp, store.path)"));
        assertTrue(main.contains("FixAcceptorConfig.storeFromEnv"));
        assertTrue(main.contains("FixAcceptor.start(parsed.config, orderApp, orderStore.path)"));
        String oe = Files.readString(Path.of("src/main/java/io/intafaced/fix/FixAcceptor.java"));
        assertTrue(oe.contains("path.isEmpty() ? new MemoryStoreFactory() : new FileStoreFactory(settings)"));
    }

    @Test
    void blankDropCopySocketsRefuseWithoutInventingPortOrCompId() {
        SessionConfigResult port = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", "", "5");
        assertFalse(port.ok);
        assertEquals("session_unconfigured", port.errorCode);
        assertTrue(port.errorMessage.contains("FIX_DROPCOPY_SOCKET_ACCEPT_PORT"));
        assertTrue(port.errorMessage.contains("invent a listen port"));

        SessionConfigResult sender = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "", "DC-CLIENT", "19001", "5");
        assertFalse(sender.ok);
        assertTrue(sender.errorMessage.contains("invent a CompID"));
    }

    @Test
    void blankDropCopyEnvRefusesAndDoesNotShareOrderEntry() {
        Map<String, String> env = new HashMap<>();
        env.put("FIX_BEGIN_STRING", FixVersions.BEGINSTRING_FIX44);
        env.put("FIX_SENDER_COMP_ID", "INTAFACED");
        env.put("FIX_TARGET_COMP_ID", "CLIENT");
        env.put("FIX_SOCKET_ACCEPT_PORT", "19000");
        env.put("FIX_HEARTBTINT", "5");
        SessionConfigResult order = FixAcceptorConfig.fromOwnerEnv(env);
        assertTrue(order.ok, order.errorMessage);
        SessionConfigResult drop = FixDropCopyConfig.requireIndependent(env, order.config);
        assertFalse(drop.ok);
        assertEquals(FixDropCopyConfig.UNCONFIGURED, drop.errorCode);
        assertTrue(drop.errorMessage.contains("second session"));
        assertNull(drop.config);
        assertFalse(drop.errorMessage.toLowerCase().contains("certified"));

        env.put("FIX_DROPCOPY_BEGIN_STRING", FixVersions.BEGINSTRING_FIX44);
        env.put("FIX_DROPCOPY_SENDER_COMP_ID", "DROPCOPY");
        env.put("FIX_DROPCOPY_TARGET_COMP_ID", "DC-CLIENT");
        env.put("FIX_DROPCOPY_SOCKET_ACCEPT_PORT", "19001");
        env.put("FIX_DROPCOPY_HEARTBTINT", "5");
        SessionConfigResult independent = FixDropCopyConfig.requireIndependent(env, order.config);
        assertTrue(independent.ok, independent.errorMessage);
        assertNotEquals(order.config.senderCompId, independent.config.senderCompId);
        assertNotEquals(order.config.socketAcceptPort, independent.config.socketAcceptPort);
    }

    @Test
    void dropCopyCompIdsMustNotEqualOrderEntry() {
        SessionConfigResult order = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "19000", "5", "");
        SessionConfigResult same = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", "19001", "5");
        SessionConfigResult independent = FixDropCopyConfig.independentOf(order.config, same.config);
        assertFalse(independent.ok);
        assertEquals("dropcopy_not_independent", independent.errorCode);

        SessionConfigResult samePort = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", "19000", "5");
        SessionConfigResult portClash = FixDropCopyConfig.independentOf(order.config, samePort.config);
        assertFalse(portClash.ok);

        SessionConfigResult ok = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", "19001", "5");
        SessionConfigResult distinct = FixDropCopyConfig.independentOf(order.config, ok.config);
        assertTrue(distinct.ok, distinct.errorMessage);
        assertNotEquals(order.config.senderCompId, ok.config.senderCompId);
    }

    @Test
    void missingUiSourceIsNotSynthesized() {
        FixDropCopyApplication drop = new FixDropCopyApplication();
        Message fake = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid", FixVersions.BEGINSTRING_FIX44, null, "BTC/USDT", "buy", "limit", "1.50", "100.25", "CLIENT", "GTC"),
                new MatchingAck(true, 4L));
        DropCopyPublishResult result = drop.publish("ui", fake);
        assertFalse(result.ok);
        assertEquals("dropcopy_source_missing", result.errorCode);
        assertTrue(result.errorMessage.contains("synthesize"));
        assertTrue(result.errorMessage.contains("included=[]"));
        assertTrue(drop.outbound().isEmpty());
        assertEquals(List.of(), drop.includedSources());
        assertEquals(0, drop.matchingPosts());
    }

    @Test
    void fixExecutionStreamsToDropCopyAndNotToMissingSources() throws Exception {
        DropCopyHub hub = new DropCopyHub();
        FixDropCopyApplication drop = new FixDropCopyApplication(hub);
        Message er = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid", FixVersions.BEGINSTRING_FIX44, null, "BTC/USDT", "buy", "limit", "1.50", "100.25", "CLIENT", "GTC"),
                new MatchingAck(true, 11L));
        DropCopyPublishResult streamed = hub.publish(DropCopyCatalog.FIX, er);
        assertTrue(streamed.ok, streamed.errorMessage);
        assertEquals(1, streamed.delivered);
        assertEquals(1, drop.outbound().size());
        assertEquals("11", drop.outbound().get(0).getString(ExecID.FIELD));
        assertFalse(drop.outbound().get(0).isSetField(quickfix.field.LastPx.FIELD));
        assertFalse(drop.outbound().get(0).toString().contains("ledger"));
        assertEquals(List.of(DropCopyCatalog.FIX), drop.includedSources());
        DropCopyCompleteness claim = drop.claimComplete();
        assertFalse(claim.complete);
        assertEquals("dropcopy_incomplete", claim.errorCode);
    }

    @Test
    void publishWithoutAListenerDoesNotReportStreamedSuccess() throws Exception {
        DropCopyHub hub = new DropCopyHub();
        Message er = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid", FixVersions.BEGINSTRING_FIX44, null, "BTC/USDT", "buy", "limit", "1.50", "100.25", "CLIENT", "GTC"),
                new MatchingAck(true, 11L));
        DropCopyPublishResult silent = hub.publish(DropCopyCatalog.FIX, er);
        assertFalse(silent.ok, silent.errorMessage);
        assertEquals(0, silent.delivered);
        assertEquals("dropcopy_not_delivered", silent.errorCode);
        assertEquals(List.of(), hub.included());
        assertFalse(hub.claimComplete().included.contains(DropCopyCatalog.FIX));

        FixDropCopyApplication listener = new FixDropCopyApplication(hub);
        DropCopyPublishResult streamed = hub.publish(DropCopyCatalog.FIX, er);
        assertTrue(streamed.ok, streamed.errorMessage);
        assertEquals(1, streamed.delivered);
        assertNull(streamed.errorCode);
        assertEquals(1, listener.outbound().size());
        assertEquals("11", listener.outbound().get(0).getString(ExecID.FIELD));
        assertEquals(List.of(DropCopyCatalog.FIX), hub.included());
    }

    @Test
    void orderEntryExecutionReportIsTheIncludedFixSource() throws Exception {
        DropCopyHub hub = new DropCopyHub();
        FixDropCopyApplication drop = new FixDropCopyApplication(hub);
        AtomicReference<String> posted = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example",
                "{\"CLIENT\":\"acct-desk\"}",
                "a".repeat(32),
                (url, json, headers) -> {
                    posted.set(json);
                    return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":6}");
                });
        FixSessionApplication order = new FixSessionApplication(new FixGatewayAdapter(), port, hub);
        NewOrderSingle nos = limitNos("CLIENT");
        order.fromApp(nos, new SessionID(FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT"));
        assertEquals(1, order.matchingPosts());
        assertEquals(1, drop.outbound().size());
        assertEquals("6", drop.outbound().get(0).getString(ExecID.FIELD));
        assertEquals(0, drop.matchingPosts());
        assertTrue(posted.get().contains("\"qty\":\"1.50\""));
        assertEquals(List.of(DropCopyCatalog.FIX), drop.includedSources());
        assertFalse(drop.claimComplete().complete);
    }

    @Test
    void dropCopyNewOrderSingleDoesNotPostMatching() throws Exception {
        FixDropCopyApplication drop = new FixDropCopyApplication();
        drop.fromApp(limitNos("DC-CLIENT"), new SessionID(FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT"));
        assertEquals(0, drop.matchingPosts());
        assertEquals(1, drop.outbound().size());
        assertEquals(MsgType.REJECT, drop.outbound().get(0).getHeader().getString(MsgType.FIELD));
        assertTrue(drop.outbound().get(0).getString(quickfix.field.Text.FIELD).contains("not the order-entry session"));
    }

    @Test
    @Timeout(20)
    void dropCopySessionLogsOnIndependently() throws Exception {
        Pair pair = Pair.start(FixVersions.BEGINSTRING_FIX44);
        try {
            assertTrue(pair.server.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy acceptor logon");
            assertTrue(pair.client.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy initiator logon");
            DropCopyCompleteness claim = pair.server.claimComplete();
            assertFalse(claim.complete);
            assertEquals("dropcopy_incomplete", claim.errorCode);
            assertEquals(List.of(), pair.server.includedSources());
        } finally {
            pair.close();
        }
    }

    @Test
    @Timeout(20)
    void orderEntryAndDropCopyAcceptorsLogOnIndependently() throws Exception {
        Dual dual = Dual.start();
        try {
            assertTrue(dual.orderServer.loggedOn.await(8, TimeUnit.SECONDS), "order-entry acceptor logon");
            assertTrue(dual.orderClient.loggedOn.await(8, TimeUnit.SECONDS), "order-entry initiator logon");
            assertTrue(dual.dropServer.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy acceptor logon");
            assertTrue(dual.dropClient.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy initiator logon");
            assertNotEquals(dual.orderPort, dual.dropPort);
            dual.orderServer.fromApp(limitNos("CLIENT"), new SessionID(FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT"));
            assertEquals(1, dual.orderServer.matchingPosts());
            assertEquals(0, dual.dropServer.matchingPosts());
            assertEquals(1, dual.dropServer.outbound().size());
            assertEquals("6", dual.dropServer.outbound().get(0).getString(ExecID.FIELD));
            DropCopyCompleteness claim = dual.dropServer.claimComplete();
            assertFalse(claim.complete);
            assertEquals("dropcopy_incomplete", claim.errorCode);
            assertEquals(List.of(DropCopyCatalog.FIX), claim.included);
        } finally {
            dual.close();
        }
    }

    @Test
    void missingSessionDoesNotInventASessionOrSequence() throws Exception {
        FixDropCopyApplication drop = new FixDropCopyApplication();
        SessionID missing = new SessionID(FixVersions.BEGINSTRING_FIX44, "NO-SUCH-DC", "NO-SUCH-CLIENT");
        assertNull(Session.lookupSession(missing));
        Message execution = execution("41");
        drop.deliver(execution);
        drop.onLogon(missing);
        assertNull(Session.lookupSession(missing));
        assertFalse(execution.getHeader().isSetField(MsgSeqNum.FIELD));
        assertEquals(1, drop.outbound().size());
        assertEquals("41", drop.outbound().get(0).getString(ExecID.FIELD));
        assertEquals(0, drop.matchingPosts());
        assertFalse(drop.outbound().get(0).toString().contains("ledger"));
    }

    @Test
    @Timeout(20)
    void executionBeforeLogonIsSentOnceWhenTheSessionLogsOn() throws Exception {
        FixDropCopyApplication server = new FixDropCopyApplication();
        SessionID serverId = new SessionID(FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT");
        Message early = execution("41");
        server.deliver(early);
        assertEquals(1, server.outbound().size());
        assertFalse(early.getHeader().isSetField(MsgSeqNum.FIELD));

        int port = Pair.freePort();
        SessionConfigResult parsed = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", Integer.toString(port), "5");
        assertTrue(parsed.ok, parsed.errorMessage);
        try (FixDropCopyAcceptor acceptor = FixDropCopyAcceptor.start(parsed.config, server)) {
            Session registered = Session.lookupSession(serverId);
            assertTrue(registered != null && !registered.isLoggedOn());
            assertFalse(early.getHeader().isSetField(MsgSeqNum.FIELD), "registered but not logged on does not assign a sequence");
            DropListener client = DropListener.connect(port);
            try {
                assertTrue(server.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy acceptor logon");
                assertTrue(client.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy initiator logon");
                awaitExec(client, "41", 1);
                assertEquals(1, count(client, "41"));
                assertEquals(1, server.outbound().size());
                assertEquals(0, server.matchingPosts());

                server.deliver(execution("42"));
                awaitExec(client, "42", 1);
                assertEquals(1, count(client, "41"));
                assertEquals(1, count(client, "42"));
                assertEquals(2, server.outbound().size());

                server.onLogon(serverId);
                Thread.sleep(400);
                assertEquals(1, count(client, "41"), "logon must not resend an execution already passed to Session.send");
                assertEquals(1, count(client, "42"));
                assertEquals(2, server.outbound().size());
            } finally {
                client.close();
            }
            assertTrue(acceptor.application == server);
        }
    }

    @Test
    @Timeout(20)
    void executionWhileLookupMissesIsSentOnceOnLogon() throws Exception {
        FixDropCopyApplication server = new FixDropCopyApplication();
        SessionID serverId = new SessionID(FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT");
        assertNull(Session.lookupSession(serverId));
        server.onLogon(serverId);
        assertNull(Session.lookupSession(serverId));
        Message early = execution("77");
        server.deliver(early);
        assertFalse(early.getHeader().isSetField(MsgSeqNum.FIELD));
        assertEquals(1, server.outbound().size());

        int port = Pair.freePort();
        SessionConfigResult parsed = FixDropCopyConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", Integer.toString(port), "5");
        assertTrue(parsed.ok, parsed.errorMessage);
        try (FixDropCopyAcceptor acceptor = FixDropCopyAcceptor.start(parsed.config, server)) {
            Session registered = Session.lookupSession(serverId);
            assertTrue(registered != null && !registered.isLoggedOn());
            assertFalse(early.getHeader().isSetField(MsgSeqNum.FIELD));
            DropListener client = DropListener.connect(port);
            try {
                assertTrue(client.loggedOn.await(8, TimeUnit.SECONDS), "drop-copy initiator logon");
                awaitExec(client, "77", 1);
                assertEquals(1, count(client, "77"));
                assertEquals(1, server.outbound().size());
                assertEquals(0, server.matchingPosts());
                assertFalse(server.outbound().get(0).toString().contains("ledger"));

                server.onLogon(serverId);
                Thread.sleep(400);
                assertEquals(1, count(client, "77"));
            } finally {
                client.close();
            }
            assertTrue(acceptor.application == server);
        }
    }

    private static Message execution(String execId) {
        Message er = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid-" + execId,
                        FixVersions.BEGINSTRING_FIX44,
                        null,
                        "BTC/USDT",
                        "buy",
                        "limit",
                        "1.50",
                        "100.25",
                        "CLIENT",
                        "GTC"),
                new MatchingAck(true, Long.parseLong(execId)));
        return er;
    }

    private static int count(DropListener client, String execId) {
        int n = 0;
        for (String id : client.execIds) {
            if (execId.equals(id)) {
                n++;
            }
        }
        return n;
    }

    private static void awaitExec(DropListener client, String execId, int times) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (count(client, execId) < times && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertEquals(times, count(client, execId), execId);
    }

    private static final class DropListener extends ApplicationAdapter implements AutoCloseable {
        final CopyOnWriteArrayList<String> execIds = new CopyOnWriteArrayList<>();
        final java.util.concurrent.CountDownLatch loggedOn = new java.util.concurrent.CountDownLatch(1);
        final SessionID sessionId = new SessionID(FixVersions.BEGINSTRING_FIX44, "DC-CLIENT", "DROPCOPY");
        SocketInitiator initiator;

        static DropListener connect(int port) throws Exception {
            DropListener app = new DropListener();
            StringBuilder text = new StringBuilder();
            text.append("[DEFAULT]\n");
            text.append("ConnectionType=initiator\n");
            text.append("HeartBtInt=5\n");
            text.append("StartTime=00:00:00\n");
            text.append("EndTime=00:00:00\n");
            text.append("UseDataDictionary=Y\n");
            text.append("ValidateIncomingMessage=N\n");
            text.append("TimeZone=UTC\n");
            text.append("ResetOnLogon=Y\n");
            text.append("ResetOnLogout=Y\n");
            text.append("ResetOnDisconnect=Y\n");
            text.append("SocketConnectHost=127.0.0.1\n");
            text.append("SocketConnectPort=").append(port).append('\n');
            text.append("ReconnectInterval=2\n");
            text.append("[SESSION]\n");
            text.append("BeginString=").append(FixVersions.BEGINSTRING_FIX44).append('\n');
            text.append("SenderCompID=DC-CLIENT\n");
            text.append("TargetCompID=DROPCOPY\n");
            text.append("DataDictionary=").append(FixDictionaries.FIX44_XML).append('\n');
            SessionSettings settings =
                    new SessionSettings(new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
            app.initiator = new SocketInitiator(
                    app,
                    new MemoryStoreFactory(),
                    settings,
                    new ScreenLogFactory(false, false, false),
                    new DefaultMessageFactory());
            app.initiator.start();
            return app;
        }

        @Override
        public void onLogon(SessionID sessionId) {
            loggedOn.countDown();
        }

        @Override
        public void fromApp(Message message, SessionID sessionId) throws FieldNotFound {
            if (MsgType.EXECUTION_REPORT.equals(message.getHeader().getString(MsgType.FIELD))) {
                execIds.add(message.getString(ExecID.FIELD));
            }
        }

        @Override
        public void close() {
            Session session = Session.lookupSession(sessionId);
            if (session != null) {
                session.logout("l218 done");
            }
            initiator.stop();
        }
    }

    private static NewOrderSingle limitNos(String sender) {
        NewOrderSingle nos = new NewOrderSingle();
        nos.getHeader().setString(quickfix.field.BeginString.FIELD, FixVersions.BEGINSTRING_FIX44);
        nos.getHeader().setString(SenderCompID.FIELD, sender);
        nos.getHeader().setString(TargetCompID.FIELD, sender.startsWith("DC") ? "DROPCOPY" : "INTAFACED");
        nos.getHeader().setInt(quickfix.field.MsgSeqNum.FIELD, 2);
        nos.getHeader().setUtcTimeStamp(SendingTime.FIELD, LocalDateTime.of(2026, 9, 2, 12, 0, 0), true);
        nos.set(new ClOrdID("clid-c3"));
        nos.set(new Symbol("BTC/USDT"));
        nos.set(new Side(Side.BUY));
        nos.set(new TransactTime(LocalDateTime.of(2026, 9, 2, 12, 0, 0)));
        nos.set(new OrdType(OrdType.LIMIT));
        nos.setString(OrderQty.FIELD, "1.50");
        nos.setString(Price.FIELD, "100.25");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        return nos;
    }

    private static final class Pair implements AutoCloseable {
        final FixDropCopyAcceptor acceptor;
        final SocketInitiator initiator;
        final FixDropCopyApplication server;
        final FixDropCopyApplication client;
        final SessionID clientId;

        private Pair(
                FixDropCopyAcceptor acceptor,
                SocketInitiator initiator,
                FixDropCopyApplication server,
                FixDropCopyApplication client,
                SessionID clientId) {
            this.acceptor = acceptor;
            this.initiator = initiator;
            this.server = server;
            this.client = client;
            this.clientId = clientId;
        }

        static Pair start(String productBegin) throws Exception {
            int port = freePort();
            SessionConfigResult parsed = FixDropCopyConfig.fromOwner(
                    productBegin, "DROPCOPY", "DC-CLIENT", Integer.toString(port), "5");
            assertTrue(parsed.ok, parsed.errorMessage);
            FixDropCopyApplication server = new FixDropCopyApplication();
            FixDropCopyAcceptor acceptor = FixDropCopyAcceptor.start(parsed.config, server);
            FixDropCopyApplication clientApp = new FixDropCopyApplication();
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
            text.append("SenderCompID=DC-CLIENT\n");
            text.append("TargetCompID=DROPCOPY\n");
            if (FixVersions.BEGINSTRING_FIXT11.equals(sessionBegin)) {
                text.append("DefaultApplVerID=7\n");
                text.append("TransportDataDictionary=").append(transportDd).append('\n');
                text.append("AppDataDictionary=").append(appDd).append('\n');
            } else {
                text.append("DataDictionary=").append(appDd).append('\n');
            }
            SessionSettings initiatorSettings =
                    new SessionSettings(new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
            SocketInitiator initiator = new SocketInitiator(
                    clientApp,
                    new MemoryStoreFactory(),
                    initiatorSettings,
                    new ScreenLogFactory(false, false, false),
                    new DefaultMessageFactory());
            initiator.start();
            SessionID clientId = new SessionID(sessionBegin, "DC-CLIENT", "DROPCOPY");
            return new Pair(acceptor, initiator, server, clientApp, clientId);
        }

        @Override
        public void close() {
            Session session = Session.lookupSession(clientId);
            if (session != null) {
                session.logout("c3 done");
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

    private static final class Dual implements AutoCloseable {
        final FixAcceptor orderAcceptor;
        final FixDropCopyAcceptor dropAcceptor;
        final SocketInitiator orderInitiator;
        final SocketInitiator dropInitiator;
        final FixSessionApplication orderServer;
        final FixDropCopyApplication dropServer;
        final FixSessionApplication orderClient;
        final FixDropCopyApplication dropClient;
        final SessionID orderClientId;
        final SessionID dropClientId;
        final int orderPort;
        final int dropPort;

        private Dual(
                FixAcceptor orderAcceptor,
                FixDropCopyAcceptor dropAcceptor,
                SocketInitiator orderInitiator,
                SocketInitiator dropInitiator,
                FixSessionApplication orderServer,
                FixDropCopyApplication dropServer,
                FixSessionApplication orderClient,
                FixDropCopyApplication dropClient,
                SessionID orderClientId,
                SessionID dropClientId,
                int orderPort,
                int dropPort) {
            this.orderAcceptor = orderAcceptor;
            this.dropAcceptor = dropAcceptor;
            this.orderInitiator = orderInitiator;
            this.dropInitiator = dropInitiator;
            this.orderServer = orderServer;
            this.dropServer = dropServer;
            this.orderClient = orderClient;
            this.dropClient = dropClient;
            this.orderClientId = orderClientId;
            this.dropClientId = dropClientId;
            this.orderPort = orderPort;
            this.dropPort = dropPort;
        }

        static Dual start() throws Exception {
            int orderPort = Pair.freePort();
            int dropPort = Pair.freePort();
            SessionConfigResult order = FixAcceptorConfig.fromOwner(
                    FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", Integer.toString(orderPort), "5", "");
            SessionConfigResult drop = FixDropCopyConfig.fromOwner(
                    FixVersions.BEGINSTRING_FIX44, "DROPCOPY", "DC-CLIENT", Integer.toString(dropPort), "5");
            assertTrue(order.ok, order.errorMessage);
            assertTrue(drop.ok, drop.errorMessage);
            SessionConfigResult independent = FixDropCopyConfig.independentOf(order.config, drop.config);
            assertTrue(independent.ok, independent.errorMessage);
            DropCopyHub hub = new DropCopyHub();
            MatchingSubmitPort matching = new MatchingSubmitPort(
                    "http://matching.example",
                    "{\"CLIENT\":\"acct-desk\"}",
                    "a".repeat(32),
                    (url, json, headers) -> new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":6}"));
            FixSessionApplication orderServer = new FixSessionApplication(new FixGatewayAdapter(), matching, hub);
            FixDropCopyApplication dropServer = new FixDropCopyApplication(hub);
            FixAcceptor orderAcceptor = FixAcceptor.start(order.config, orderServer);
            FixDropCopyAcceptor dropAcceptor = FixDropCopyAcceptor.start(drop.config, dropServer);
            FixSessionApplication orderClient = new FixSessionApplication();
            FixDropCopyApplication dropClient = new FixDropCopyApplication();
            SocketInitiator orderInitiator = startInitiator(orderClient, orderPort, "CLIENT", "INTAFACED");
            SocketInitiator dropInitiator = startInitiator(dropClient, dropPort, "DC-CLIENT", "DROPCOPY");
            return new Dual(
                    orderAcceptor,
                    dropAcceptor,
                    orderInitiator,
                    dropInitiator,
                    orderServer,
                    dropServer,
                    orderClient,
                    dropClient,
                    new SessionID(FixVersions.BEGINSTRING_FIX44, "CLIENT", "INTAFACED"),
                    new SessionID(FixVersions.BEGINSTRING_FIX44, "DC-CLIENT", "DROPCOPY"),
                    orderPort,
                    dropPort);
        }

        static SocketInitiator startInitiator(
                quickfix.Application application, int port, String sender, String target) throws Exception {
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
            text.append("BeginString=").append(FixVersions.BEGINSTRING_FIX44).append('\n');
            text.append("SenderCompID=").append(sender).append('\n');
            text.append("TargetCompID=").append(target).append('\n');
            text.append("DataDictionary=").append(FixDictionaries.FIX44_XML).append('\n');
            SessionSettings settings =
                    new SessionSettings(new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
            SocketInitiator initiator = new SocketInitiator(
                    application,
                    new MemoryStoreFactory(),
                    settings,
                    new ScreenLogFactory(false, false, false),
                    new DefaultMessageFactory());
            initiator.start();
            return initiator;
        }

        @Override
        public void close() {
            Session orderSession = Session.lookupSession(orderClientId);
            if (orderSession != null) {
                orderSession.logout("h1b order done");
            }
            Session dropSession = Session.lookupSession(dropClientId);
            if (dropSession != null) {
                dropSession.logout("h1b drop done");
            }
            orderInitiator.stop();
            dropInitiator.stop();
            orderAcceptor.close();
            dropAcceptor.close();
        }
    }
}
