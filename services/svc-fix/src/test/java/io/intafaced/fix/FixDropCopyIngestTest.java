package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import quickfix.FixVersions;
import quickfix.Message;
import quickfix.field.AvgPx;
import quickfix.field.CumQty;
import quickfix.field.ExecID;
import quickfix.field.ExecType;
import quickfix.field.LastPx;
import quickfix.field.LastQty;
import quickfix.field.OrdStatus;

class FixDropCopyIngestTest {
    private static final String SECRET = "a".repeat(32);
    private static final String FILL =
            "{\"fillId\":\"fill-7\",\"orderId\":\"ord-1\",\"userId\":\"user-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"price\":\"100.25\",\"qty\":\"1.50\",\"quoteAmount\":\"150.375\",\"feeAsset\":\"USDT\",\"feeAmount\":\"0.15\",\"sequence\":11,\"ts\":\"2026-09-18T00:00:00Z\",\"source\":\"rest\"}";

    @Test
    void fromFillUsesPayloadExecIdAndLastOnlyWhenStringsPresent() throws Exception {
        DropCopyFill.ParseResult parsed = DropCopyFill.parse(FILL);
        assertTrue(parsed.ok, parsed.errorMessage);
        Message er = ExecutionReportFactory.fromFill(FixVersions.BEGINSTRING_FIX44, parsed.fill);
        assertEquals("fill-7", er.getString(ExecID.FIELD));
        assertFalse(er.getString(ExecID.FIELD).matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"));
        assertEquals("100.25", er.getString(LastPx.FIELD));
        assertEquals("1.50", er.getString(LastQty.FIELD));
        assertFalse(er.isSetField(AvgPx.FIELD));
        assertFalse(er.isSetField(CumQty.FIELD));
        assertFalse(er.toString().toLowerCase().contains("ledger"));

        DropCopyFill.ParseResult seqOnly = DropCopyFill.parse(
                "{\"orderId\":\"ord-1\",\"marketId\":\"BTC/USDT\",\"side\":\"sell\",\"price\":\"100.25\",\"qty\":\"1.50\",\"sequence\":44,\"source\":\"algo\"}");
        assertTrue(seqOnly.ok, seqOnly.errorMessage);
        assertEquals("44", ExecutionReportFactory.fromFill(FixVersions.BEGINSTRING_FIX44, seqOnly.fill)
                .getString(ExecID.FIELD));
        assertEquals("100.25", seqOnly.fill.price);
        assertEquals("1.50", seqOnly.fill.qty);

        DropCopyFill.ParseResult missing = DropCopyFill.parse(
                "{\"orderId\":\"ord-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"source\":\"rest\"}");
        assertFalse(missing.ok);
        assertEquals("dropcopy_execution_missing", missing.errorCode);

        DropCopyFill.ParseResult ieee = DropCopyFill.parse(
                "{\"fillId\":\"fill-9\",\"orderId\":\"ord-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"price\":100.25,\"qty\":\"1.50\",\"source\":\"rest\"}");
        assertFalse(ieee.ok);
        assertEquals("invalid_decimal", ieee.errorCode);
        assertNull(ExecutionReportFactory.fromFill(FixVersions.BEGINSTRING_FIX44, null));
    }

    @Test
    void partialFillIsNotACompleteFillAndThisPrintIsNotCumulative() throws Exception {
        DropCopyFill.ParseResult parsed = DropCopyFill.parse(FILL);
        assertTrue(parsed.ok, parsed.errorMessage);

        Message fix42 = ExecutionReportFactory.fromFill(FixVersions.BEGINSTRING_FIX42, parsed.fill);
        assertEquals(OrdStatus.PARTIALLY_FILLED, fix42.getChar(OrdStatus.FIELD));
        assertEquals(ExecType.PARTIAL_FILL, fix42.getChar(ExecType.FIELD));
        assertEquals("100.25", fix42.getString(LastPx.FIELD));
        assertEquals("1.50", fix42.getString(LastQty.FIELD));
        assertFalse(fix42.isSetField(CumQty.FIELD));
        assertFalse(fix42.isSetField(AvgPx.FIELD));

        Message fix44 = ExecutionReportFactory.fromFill(FixVersions.BEGINSTRING_FIX44, parsed.fill);
        assertEquals(OrdStatus.PARTIALLY_FILLED, fix44.getChar(OrdStatus.FIELD));
        assertEquals(ExecType.TRADE, fix44.getChar(ExecType.FIELD));
        assertEquals("100.25", fix44.getString(LastPx.FIELD));
        assertEquals("1.50", fix44.getString(LastQty.FIELD));
        assertFalse(fix44.isSetField(CumQty.FIELD));
        assertFalse(fix44.isSetField(AvgPx.FIELD));

        assertNull(ExecutionReportFactory.fromFill(
                FixVersions.BEGINSTRING_FIX42,
                fill("fill-7", null, "1.50")));
        assertNull(ExecutionReportFactory.fromFill(
                FixVersions.BEGINSTRING_FIX44,
                fill("fill-7", "100.25", null)));
    }

    @Test
    void fillWithMissingNullOrNonStringPriceOrQtyIsRefused() {
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"qty\":\"1.50\",\"source\":\"rest\"}", "dropcopy_price_missing");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":\"100.25\",\"source\":\"rest\"}", "dropcopy_qty_missing");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":null,\"qty\":\"1.50\",\"source\":\"rest\"}",
                "dropcopy_price_missing");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":\"100.25\",\"qty\":null,\"source\":\"rest\"}",
                "dropcopy_qty_missing");
        assertFillRefused(
                "{\"fillId\":\"fill-8\",\"orderId\":\"ord-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"sequence\":12,\"source\":\"ws\"}",
                "dropcopy_price_missing");
        assertFillRefused(
                "{\"orderId\":\"ord-1\",\"marketId\":\"BTC/USDT\",\"side\":\"sell\",\"sequence\":44,\"source\":\"algo\"}",
                "dropcopy_price_missing");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":true,\"qty\":\"1.50\",\"source\":\"rest\"}", "invalid_decimal");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":{},\"qty\":\"1.50\",\"source\":\"rest\"}", "invalid_decimal");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":\"100.25\",\"qty\":false,\"source\":\"rest\"}", "invalid_decimal");
        assertFillRefused(
                "{\"fillId\":\"fill-7\",\"price\":\"100.25\",\"qty\":[],\"source\":\"rest\"}", "invalid_decimal");
    }

    private static DropCopyFill fill(String fillId, String price, String qty) {
        return new DropCopyFill(
                fillId, "ord-1", "user-1", "BTC/USDT", "buy", price, qty, null, null, null, 11L, null, "rest");
    }

    private static void assertFillRefused(String raw, String code) {
        DropCopyFill.ParseResult parsed = DropCopyFill.parse(raw);
        assertFalse(parsed.ok, raw);
        assertNull(parsed.fill, raw);
        assertEquals(code, parsed.errorCode, raw);
    }

    @Test
    @Timeout(20)
    void hmacMissingUiRefuseRestPublishCompletenessStaysFalse() throws Exception {
        int port = freePort();
        DropCopyHub hub = new DropCopyHub();
        FixDropCopyApplication drop = new FixDropCopyApplication(hub);
        DropCopyIngest.Result started =
                DropCopyIngest.start(port, FixVersions.BEGINSTRING_FIX44, SECRET, hub);
        assertTrue(started.ok, started.errorMessage);
        try (DropCopyIngest ignored = started.ingest) {
            HttpResponse<String> unsigned = post(port, FILL, Map.of());
            assertEquals(401, unsigned.statusCode());
            assertTrue(unsigned.body().contains("unauthenticated"));
            assertTrue(drop.includedSources().isEmpty());
            assertTrue(drop.outbound().isEmpty());

            HttpResponse<String> ui = post(port, withSource(FILL, "ui"), signed(withSource(FILL, "ui")));
            assertEquals(400, ui.statusCode());
            assertTrue(ui.body().contains("dropcopy_source_missing"));
            assertTrue(drop.includedSources().isEmpty());

            HttpResponse<String> rest = post(port, FILL, signed(FILL));
            assertEquals(200, rest.statusCode(), rest.body());
            assertEquals(1, drop.outbound().size());
            assertEquals("fill-7", drop.outbound().get(0).getString(ExecID.FIELD));
            assertEquals("100.25", drop.outbound().get(0).getString(LastPx.FIELD));
            assertEquals(java.util.List.of(DropCopyCatalog.REST), drop.includedSources());

            DropCopyCompleteness claim = drop.claimComplete();
            assertFalse(claim.complete);
            assertEquals("dropcopy_incomplete", claim.errorCode);
            assertTrue(claim.missing.contains(DropCopyCatalog.UI));
            assertTrue(claim.missing.contains(DropCopyCatalog.FIX));

            String wsBody = withSource(FILL.replace("fill-7", "fill-ws"), "ws");
            assertEquals(200, post(port, wsBody, signed(wsBody)).statusCode());
            for (String source : java.util.List.of(
                    DropCopyCatalog.ALGO, DropCopyCatalog.LIQUIDATION, DropCopyCatalog.RFQ, DropCopyCatalog.BROKER)) {
                String body = withSource(FILL.replace("fill-7", "fill-" + source), source);
                assertEquals(200, post(port, body, signed(body)).statusCode(), source);
            }
            DropCopyCompleteness hitchable = drop.claimComplete();
            assertFalse(hitchable.complete);
            assertTrue(hitchable.included.contains(DropCopyCatalog.REST));
            assertTrue(hitchable.included.contains(DropCopyCatalog.WS));
            assertTrue(hitchable.included.contains(DropCopyCatalog.ALGO));
            assertFalse(hitchable.included.contains(DropCopyCatalog.UI));
            assertTrue(hitchable.missing.contains(DropCopyCatalog.UI));
            assertTrue(hitchable.missing.contains(DropCopyCatalog.FIX));
        }
    }

    @Test
    void ingestDoesNotReadComposeBodyBindEnv() throws Exception {
        String ingest = Files.readString(Path.of("src/main/java/io/intafaced/fix/DropCopyIngest.java"));
        String auth = Files.readString(Path.of("src/main/java/io/intafaced/fix/ServiceAuth.java"));
        assertFalse(ingest.contains("INTERNAL_SERVICE_BODY_BIND"));
        assertFalse(auth.contains("INTERNAL_SERVICE_BODY_BIND"));
        assertTrue(ingest.contains("BODY_BIND_REQUIRE"));
        assertTrue(auth.contains("BODY_BIND_REQUIRE"));
    }

    private static String withSource(String json, String source) {
        return json.replace("\"source\":\"rest\"", "\"source\":\"" + source + "\"");
    }

    private static Map<String, String> signed(String body) {
        return ServiceAuth.headersForBody(SECRET, "svc-trade", body, Instant.now().getEpochSecond());
    }

    private static HttpResponse<String> post(int port, String body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + DropCopyIngest.PATH))
                .timeout(Duration.ofSeconds(5))
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        for (Map.Entry<String, String> header : headers.entrySet()) {
            builder.header(header.getKey(), header.getValue());
        }
        return HttpClient.newHttpClient().send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        }
    }
}
