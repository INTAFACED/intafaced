package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import quickfix.DefaultMessageFactory;
import quickfix.FixVersions;
import quickfix.MemoryStoreFactory;
import quickfix.ScreenLogFactory;
import quickfix.SessionSettings;
import quickfix.SocketInitiator;

/** J-cex-spot-20 #3: the adapter's own status, read from QuickFIX/J and the CompID map, signed by svc-edge only. */
class AdapterStatusTest {
    private static final String INGEST_SECRET = "i".repeat(32);
    private static final String STATUS_SECRET = "s".repeat(32);
    private static final String MAP = "{\"CLIENT\":\"acct-client-1\",\"OTHER\":\"acct-other-2\"}";

    @Test
    @Timeout(30)
    void sessionStateFollowsQuickFixAndTheCompIdMapNamesTheCounterpartysAccount() throws Exception {
        int port = freePort();
        SessionConfigResult parsed = FixAcceptorConfig.fromOwner(
                FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT", Integer.toString(port), "5", "");
        assertTrue(parsed.ok, parsed.errorMessage);
        Map<String, String> map = MatchingSubmitPort.readCompIdAccountMap(MAP);
        try (FixAcceptor acceptor = FixAcceptor.start(parsed.config, new FixSessionApplication())) {
            List<AdapterStatus.SessionRow> before = AdapterStatus.rows(AdapterStatus.ORDER_ENTRY, acceptor.sessions(), map);
            assertEquals(1, before.size());
            AdapterStatus.SessionRow row = before.get(0);
            assertEquals("INTAFACED", row.senderCompId());
            assertEquals("CLIENT", row.targetCompId());
            assertEquals(AdapterStatus.NOT_LOGGED_ON, row.state());
            // The counterparty's CompID (the session's TargetCompID) keys the account its orders submit as.
            assertEquals("acct-client-1", row.accountId());

            FixSessionApplication clientApp = new FixSessionApplication();
            SocketInitiator initiator = initiator(port, clientApp);
            initiator.start();
            try {
                long deadline = System.currentTimeMillis() + 15_000;
                String state = AdapterStatus.NOT_LOGGED_ON;
                while (System.currentTimeMillis() < deadline) {
                    state = AdapterStatus.rows(AdapterStatus.ORDER_ENTRY, acceptor.sessions(), map).get(0).state();
                    if (AdapterStatus.LOGGED_ON.equals(state)) {
                        break;
                    }
                    Thread.sleep(100);
                }
                assertEquals(AdapterStatus.LOGGED_ON, state);
            } finally {
                initiator.stop(true);
            }

            // A drop-copy session carries no orders and maps to no account, even when its CompID is in the map.
            AdapterStatus.SessionRow drop =
                    AdapterStatus.rows(AdapterStatus.DROP_COPY, acceptor.sessions(), map).get(0);
            assertNull(drop.accountId());
            // An order-entry counterparty missing from the map stays unmapped; svc-fix invents no account.
            assertNull(AdapterStatus.rows(AdapterStatus.ORDER_ENTRY, acceptor.sessions(), Map.of("OTHER", "x"))
                    .get(0)
                    .accountId());
        }
    }

    @Test
    void theBodyCarriesSessionsAndTheWholeMapAndNoMoneyField() {
        Map<String, String> map = MatchingSubmitPort.readCompIdAccountMap(MAP);
        String json = AdapterStatus.json(
                List.of(new AdapterStatus.SessionRow(
                        AdapterStatus.ORDER_ENTRY, "FIX.4.4", "INTAFACED", "CLIENT", AdapterStatus.NOT_LOGGED_ON,
                        "acct-client-1", 1, 1)),
                map,
                Instant.parse("2026-11-07T00:00:00Z"));
        assertTrue(json.contains("\"senderCompId\":\"INTAFACED\""));
        assertTrue(json.contains("\"compIdMapSet\":true"));
        assertTrue(json.contains("{\"compId\":\"OTHER\",\"accountId\":\"acct-other-2\"}"));
        assertTrue(json.contains("\"asOf\":\"2026-11-07T00:00:00Z\""));
        for (String word : List.of("balance", "margin", "greeks", "delta")) {
            assertFalse(json.toLowerCase().contains(word), word);
        }
        String unset = AdapterStatus.json(List.of(), null, Instant.EPOCH);
        assertTrue(unset.contains("\"compIdMapSet\":false,\"compIdMap\":[]"));
    }

    @Test
    @Timeout(20)
    void onlyASignedSvcEdgeReadsTheStatus() throws Exception {
        DropCopyIngest.Result started =
                DropCopyIngest.start(freePort(), FixVersions.BEGINSTRING_FIX44, INGEST_SECRET, null);
        assertTrue(started.ok, started.errorMessage);
        try (DropCopyIngest ingest = started.ingest) {
            ingest.mount(AdapterStatus.HEALTH_PATH, AdapterStatus.health());
            ingest.mount(AdapterStatus.PATH, AdapterStatus.handler(() -> "{\"sessions\":[]}", STATUS_SECRET, null));
            String base = "http://127.0.0.1:" + ingest.port();
            HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

            assertEquals(200, get(http, base + AdapterStatus.HEALTH_PATH, Map.of()).statusCode());
            assertEquals(401, get(http, base + AdapterStatus.PATH, Map.of()).statusCode());

            long now = Instant.now().getEpochSecond();
            HttpResponse<String> ok =
                    get(http, base + AdapterStatus.PATH, ServiceAuth.headersForBody(STATUS_SECRET, "svc-edge", "", now));
            assertEquals(200, ok.statusCode());
            assertEquals("{\"sessions\":[]}", ok.body());

            // The fleet secret is not the read key, and no other service reads it.
            assertEquals(
                    401,
                    get(http, base + AdapterStatus.PATH, ServiceAuth.headersForBody(INGEST_SECRET, "svc-edge", "", now))
                            .statusCode());
            assertEquals(
                    403,
                    get(http, base + AdapterStatus.PATH, ServiceAuth.headersForBody(STATUS_SECRET, "svc-trade", "", now))
                            .statusCode());
            // A stale signature is refused.
            assertEquals(
                    401,
                    get(http, base + AdapterStatus.PATH, ServiceAuth.headersForBody(STATUS_SECRET, "svc-edge", "", now - 3600))
                            .statusCode());

            ingest.mount("/internal/status-blank", AdapterStatus.handler(() -> "{}", "", null));
            HttpResponse<String> blank = get(
                    http, base + "/internal/status-blank", ServiceAuth.headersForBody(STATUS_SECRET, "svc-edge", "", now));
            assertEquals(503, blank.statusCode());
            assertTrue(blank.body().contains(AdapterStatus.UNCONFIGURED));
        }
    }

    private static HttpResponse<String> get(HttpClient http, String url, Map<String, String> headers) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5)).GET();
        headers.forEach(req::header);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static SocketInitiator initiator(int port, FixSessionApplication app) throws Exception {
        String text = "[DEFAULT]\nConnectionType=initiator\nHeartBtInt=5\nStartTime=00:00:00\nEndTime=00:00:00\n"
                + "UseDataDictionary=Y\nTimeZone=UTC\nResetOnLogon=Y\nResetOnLogout=Y\nResetOnDisconnect=Y\n"
                + "SocketConnectHost=127.0.0.1\nSocketConnectPort=" + port + "\nReconnectInterval=1\n"
                + "[SESSION]\nBeginString=FIX.4.4\nSenderCompID=CLIENT\nTargetCompID=INTAFACED\n"
                + "DataDictionary=" + FixDictionaries.applicationResource(FixVersions.BEGINSTRING_FIX44) + "\n";
        SessionSettings settings = new SessionSettings(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
        return new SocketInitiator(
                app, new MemoryStoreFactory(), settings, new ScreenLogFactory(false, false, false), new DefaultMessageFactory());
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }
}
