package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import quickfix.FixVersions;

class MatchingSubmitPortTest {
    private static final String OWNER_MAP = "{\"CLIENT\":\"acct-desk\"}";
    private static final String SECRET = "a".repeat(32);

    private final MatchingOrderCommand limit = new MatchingOrderCommand(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            FixVersions.BEGINSTRING_FIX44,
            null,
            "BTC/USDT",
            "buy",
            "limit",
            "1.50",
            "100.25",
            "CLIENT",
            "GTC");

    @Test
    void gatewayOffRefusesEveryNewOrderBeforePost() {
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, SECRET, null, (url, json, headers) -> {
                    throw new AssertionError("must not POST while FIX order entry is off");
                }, false);
        MatchingSubmitResult result = port.submit(limit);
        assertFalse(result.ok);
        assertFalse(result.httpSent);
        assertEquals("fix_gateway_off", result.errorCode);
    }

    @Test
    void gatewayOffFromEnvRefusesBeforeAnyOtherCheck() {
        MatchingSubmitPort port = MatchingSubmitPort.fromEnv(Map.of(
                MatchingSubmitPort.GATEWAY_ENABLED_ENV, "off",
                MatchingSubmitPort.BASE_URL_ENV, "http://127.0.0.1:1",
                MatchingSubmitPort.COMPID_ACCOUNT_JSON_ENV, OWNER_MAP,
                MatchingSubmitPort.SERVICE_SECRET_ENV, SECRET));
        MatchingSubmitResult result = port.submit(limit);
        assertEquals("fix_gateway_off", result.errorCode);
        assertFalse(result.httpSent);
    }

    @Test
    void gatewaySwitchReadsUnsetAsOnAndOnlyTheOffWordsAsOff() {
        assertTrue(MatchingSubmitPort.gatewayEnabled(null));
        assertTrue(MatchingSubmitPort.gatewayEnabled(""));
        assertTrue(MatchingSubmitPort.gatewayEnabled("on"));
        assertTrue(MatchingSubmitPort.gatewayEnabled("true"));
        for (String off : new String[] {"0", "false", "off", "no", " OFF ", "False"}) {
            assertFalse(MatchingSubmitPort.gatewayEnabled(off), off);
        }
    }

    @Test
    void gatewayOnStillPosts() {
        AtomicReference<String> posted = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, SECRET, null, (url, json, headers) -> {
                    posted.set(json);
                    return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
                }, true);
        MatchingSubmitResult result = port.submit(limit);
        assertTrue(result.ok, result.errorMessage);
        assertTrue(result.httpSent);
    }

    @Test
    void unmappedCompIdRefusesBeforePost() {
        AtomicReference<String> posted = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, SECRET, (url, json, headers) -> {
                    posted.set(json);
                    return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
                });
        MatchingOrderCommand ghost = new MatchingOrderCommand(
                limit.clOrdId, limit.beginString, null, limit.symbol, limit.side, limit.ordType, limit.qty, limit.price, "GHOST", "GTC");
        MatchingSubmitResult result = port.submit(ghost);
        assertFalse(result.ok);
        assertFalse(result.httpSent);
        assertEquals("matching_account_unmapped", result.errorCode);
        assertNull(posted.get());
    }

    @Test
    void missingTifRefusesBeforePost() {
        MatchingSubmitPort port = new MatchingSubmitPort("http://matching.example", OWNER_MAP, SECRET, (url, json, headers) -> {
            throw new AssertionError("must not POST");
        });
        MatchingOrderCommand missing = new MatchingOrderCommand(
                limit.clOrdId, limit.beginString, null, limit.symbol, limit.side, limit.ordType, limit.qty, limit.price, "CLIENT", null);
        MatchingSubmitResult result = port.submit(missing);
        assertFalse(result.ok);
        assertFalse(result.httpSent);
        assertEquals("tif_missing", result.errorCode);
    }

    @Test
    void blankMatchingUrlRefusesWithoutInventingHost() {
        MatchingSubmitPort port = new MatchingSubmitPort("", OWNER_MAP, SECRET, (url, json, headers) -> {
            throw new AssertionError("must not POST");
        });
        MatchingSubmitResult result = port.submit(limit);
        assertFalse(result.ok);
        assertEquals("matching_unconfigured", result.errorCode);
        assertTrue(result.errorMessage.contains("invent"));
        assertFalse(result.errorMessage.toLowerCase().contains("localhost"));
    }

    @Test
    void mappedCompIdPostsDecimalStringsAndKeepsMatchingSequence() {
        AtomicReference<String> url = new AtomicReference<>();
        AtomicReference<String> json = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort("http://matching.example/", OWNER_MAP, SECRET, (postedUrl, body, headers) -> {
            url.set(postedUrl);
            json.set(body);
            return new MatchingSubmitPort.Transport.Response(
                    200,
                    "{\"accepted\":true,\"sequence\":7,\"fills\":[{\"price\":99.5,\"qty\":1.5}],\"last\":99.5,\"account\":\"ghost\"}");
        });
        MatchingSubmitResult result = port.submit(limit);
        assertTrue(result.ok, result.errorMessage);
        assertTrue(result.httpSent);
        assertEquals(7L, result.ack.sequence);
        assertTrue(url.get().endsWith("/markets/BTC%2FUSDT/orders"));
        assertTrue(json.get().contains("\"qty\":\"1.50\""));
        assertTrue(json.get().contains("\"price\":\"100.25\""));
        assertTrue(json.get().contains("\"accountId\":\"acct-desk\""));
        assertTrue(json.get().contains("\"tif\":\"GTC\""));
        assertFalse(json.get().contains("lastPrice"));
        assertFalse(json.get().contains("99.5"));
        assertFalse(json.get().contains("ledger"));
    }

    @Test
    void ieeeSequenceIsNotTreatedAsMoney() {
        MatchingSubmitPort port = new MatchingSubmitPort("http://matching.example", OWNER_MAP, SECRET, (u, b, headers) ->
                new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1.5,\"last\":100.25}"));
        MatchingSubmitResult result = port.submit(limit);
        assertFalse(result.ok);
        assertEquals("matching_rejected", result.errorCode);
    }

    @Test
    void postsServiceAuthHeadersAsSvcFix() {
        AtomicReference<Map<String, String>> headers = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, SECRET, (u, body, h) -> {
                    headers.set(h);
                    return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
                });
        MatchingSubmitResult result = port.submit(limit);
        assertTrue(result.ok, result.errorMessage);
        Map<String, String> sent = headers.get();
        assertEquals(ServiceAuth.SERVICE_NAME, sent.get(ServiceAuth.SERVICE_HEADER));
        assertTrue(sent.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER).matches("\\d+"));
        assertTrue(sent.get(ServiceAuth.SERVICE_BODY_DIGEST_HEADER).matches("[0-9a-f]{64}"));
        assertTrue(sent.get(ServiceAuth.SERVICE_SIGNATURE_HEADER).matches("[0-9a-f]{64}"));
        long ts = Long.parseLong(sent.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER));
        Map<String, String> expected = ServiceAuth.headersForBody(SECRET, MatchingSubmitPort.submitJson(limit, "acct-desk"), ts);
        assertEquals(expected, sent);
    }

    @Test
    void blankSecretRefusesBeforeUnsignedPost() {
        AtomicReference<String> posted = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort("http://matching.example", OWNER_MAP, "", (url, json, headers) -> {
            posted.set(json);
            return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
        });
        MatchingSubmitResult result = port.submit(limit);
        assertFalse(result.ok);
        assertFalse(result.httpSent);
        assertEquals("matching_service_auth_unconfigured", result.errorCode);
        assertTrue(result.errorMessage.contains("unsigned"));
        assertNull(posted.get());
    }

    @Test
    void noLedgerClientOnThePort() {
        assertFalse(MatchingSubmitPort.class.getName().contains("ledger"));
        assertFalse(ExecutionReportFactory.class.getName().contains("ledger"));
    }
}
