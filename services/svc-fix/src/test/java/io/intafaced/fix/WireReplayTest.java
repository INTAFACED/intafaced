package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * The wire replay. {@code src/wire-replay.golden.json} holds what svc-fix answered on main (2026-11-19, before any of
 * its callers moved to records) to a matrix of HTTP requests: every route its listener serves, and paths next to them,
 * several methods, eleven callers and nine fill bodies, against four boots of the process's own composition
 * ({@link FixAcceptorMain#start}). Today's svc-fix must answer each one with the same status, content type and body,
 * byte for byte. A changed refusal code, a widened caller, a moved path or a changed envelope shows here as a
 * difference.
 *
 * <p>The status body's {@code asOf} is the clock, so it is recorded as {@code <now>}. Requests are signed afresh each
 * run (signatures carry the time and a nonce); what is recorded is each request's method, path, body and caller.
 *
 * <p>{@code WIRE_REPLAY_WRITE=1} rewrites the golden file. Only for a change that is meant to change the wire, named in
 * its PR.
 */
class WireReplayTest {
    private static final Path GOLDEN = Path.of("src/wire-replay.golden.json");
    private static final int ANSWERS = 1144;
    private static final String FLEET_SECRET = "a-fix-wire-replay-fleet-secret-long-enough";
    private static final String STATUS_SECRET = "a-fix-wire-replay-status-secret-long-enough";
    private static final String WRONG_SECRET = "not-the-secret-svc-fix-holds-but-long-enough";
    private static final String COMPID_MAP = "{\"TEST-CLIENT\":\"TEST-fix-account\",\"TEST-DESK\":\"TEST-desk-account\"}";
    private static final String FILL =
            "{\"fillId\":\"fill-7\",\"orderId\":\"ord-1\",\"userId\":\"user-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"price\":\"100.25\",\"qty\":\"1.50\",\"quoteAmount\":\"150.375\",\"feeAsset\":\"USDT\",\"feeAmount\":\"0.15\",\"sequence\":11,\"ts\":\"2026-09-18T00:00:00Z\",\"source\":\"rest\"}";

    /** The bodies a fill route is sent. {@code null} here means no body at all. */
    private static final List<String[]> FILL_BODIES = List.of(
            new String[] {"valid", FILL},
            new String[] {"absent", null},
            new String[] {"null", "null"},
            new String[] {"wrong-type", "7"},
            new String[] {"empty-object", "{}"},
            new String[] {"source-ui", FILL.replace("\"rest\"", "\"ui\"")},
            new String[] {"no-price", FILL.replace("\"price\":\"100.25\",", "")},
            new String[] {"number-price", FILL.replace("\"100.25\"", "100.25")},
            new String[] {"all-null", FILL.replaceAll("\":(\"[^\"]*\"|[0-9]+)", "\":null")});

    /** Every route the listener serves, the paths next to them, and the methods each is sent. */
    private static final List<String[]> ROUTES = List.of(
            new String[] {"GET", "/health"},
            new String[] {"POST", "/health"},
            new String[] {"GET", "/healthz"},
            new String[] {"GET", "/health/x"},
            new String[] {"GET", "/internal/status"},
            new String[] {"POST", "/internal/status"},
            new String[] {"GET", "/internal/status?x=1"},
            new String[] {"GET", "/internal/status/x"},
            new String[] {"POST", "/internal/drop-copy/fills"},
            new String[] {"PUT", "/internal/drop-copy/fills"},
            new String[] {"GET", "/internal/drop-copy/fills"},
            new String[] {"POST", "/internal/drop-copy/fills/extra"},
            new String[] {"GET", "/internal"},
            new String[] {"GET", "/"});

    private static final List<String> CALLERS = List.of(
            "anon",
            "hmac-edge-status",
            "hmac-edge-fleet",
            "hmac-trade-fleet",
            "hmac-ledger-fleet",
            "hmac-trade-wrong-secret",
            "hmac-trade-other-body",
            "hmac-trade-stale",
            "key-edge",
            "key-trade",
            "key-ledger",
            "key-trade-wrong-audience",
            "key-unknown");

    /** Per-run Ed25519 keys: svc-fix's own (it signs its calls to matching), and three callers', plus one unlisted. */
    private final Map<String, KeyPair> pairs = new LinkedHashMap<>();

    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    @Test
    @Timeout(240)
    void everyRequestInTheMatrixGetsTheRecordedAnswerByteForByte() throws Exception {
        for (String svc : List.of("svc-fix", "svc-edge", "svc-trade", "svc-ledger", "svc-ops")) {
            pairs.put(svc, KeyPairGenerator.getInstance("Ed25519").generateKeyPair());
        }
        Map<String, String> now = replay();
        String text = render(now);
        if ("1".equals(System.getenv("WIRE_REPLAY_WRITE"))) {
            Files.writeString(GOLDEN, text);
        }
        Map<String, String> golden = parse(Files.readString(GOLDEN));
        assertEquals(ANSWERS, golden.size(), "the golden file's answer count");
        List<String> diffs = new ArrayList<>();
        for (Map.Entry<String, String> was : golden.entrySet()) {
            String got = now.get(was.getKey());
            if (!was.getValue().equals(got)) {
                diffs.add(was.getKey() + ":\n  was " + was.getValue() + "\n  now " + got);
            }
        }
        for (String key : now.keySet()) {
            if (!golden.containsKey(key)) {
                diffs.add(key + ": not in the golden file");
            }
        }
        assertTrue(diffs.isEmpty(), diffs.size() + " differences:\n" + String.join("\n", diffs));
    }

    private Map<String, String> replay() throws Exception {
        Map<String, String> answers = new LinkedHashMap<>();
        for (String config : List.of("shared", "shared-blank-status", "dual", "keypair")) {
            FixAcceptorMain.Started started = FixAcceptorMain.start(env(config));
            assertTrue(started.ok, config + ": " + started.errorCode + " " + started.errorMessage);
            try (FixAcceptorMain.Running running = started.running) {
                for (String[] route : ROUTES) {
                    boolean fills = route[1].startsWith(DropCopyIngest.PATH) && !"GET".equals(route[0]);
                    List<String[]> bodies = fills && route[1].equals(DropCopyIngest.PATH) && "POST".equals(route[0])
                            ? FILL_BODIES
                            : fills ? FILL_BODIES.subList(0, 1) : List.<String[]>of(new String[] {"none", null});
                    for (String[] body : bodies) {
                        for (String caller : CALLERS) {
                            String key = config + " " + route[0] + " " + route[1] + " " + body[0] + " " + caller;
                            answers.put(key, hit(running.httpPort(), route[0], route[1], body[1], caller));
                        }
                    }
                }
            }
        }
        return answers;
    }

    private Map<String, String> env(String config) throws Exception {
        Map<String, String> env = new LinkedHashMap<>();
        env.put(FixAcceptorConfig.BEGIN_STRING_ENV, "FIX.4.4");
        env.put(FixAcceptorConfig.SENDER_COMP_ID_ENV, "INTAFACED-TEST");
        env.put(FixAcceptorConfig.TARGET_COMP_ID_ENV, "TEST-CLIENT");
        env.put(FixAcceptorConfig.SOCKET_ACCEPT_PORT_ENV, Integer.toString(freePort()));
        env.put(FixAcceptorConfig.HEARTBTINT_ENV, "30");
        env.put(FixDropCopyConfig.BEGIN_STRING_ENV, "FIX.4.4");
        env.put(FixDropCopyConfig.SENDER_COMP_ID_ENV, "INTAFACED-TEST-DC");
        env.put(FixDropCopyConfig.TARGET_COMP_ID_ENV, "TEST-CLIENT-DC");
        env.put(FixDropCopyConfig.SOCKET_ACCEPT_PORT_ENV, Integer.toString(freePort()));
        env.put(FixDropCopyConfig.HEARTBTINT_ENV, "30");
        env.put(DropCopyIngestConfig.PORT_ENV, Integer.toString(freePort()));
        // Nothing listens here: no request in the matrix reaches matching.
        env.put(MatchingSubmitPort.BASE_URL_ENV, "http://127.0.0.1:9");
        env.put(ServiceAuth.SECRET_ENV, FLEET_SECRET);
        env.put(AdapterStatus.SECRET_ENV, STATUS_SECRET);
        env.put(MatchingSubmitPort.COMPID_ACCOUNT_JSON_ENV, COMPID_MAP);
        switch (config) {
            case "shared" -> {}
            case "shared-blank-status" -> {
                env.remove(AdapterStatus.SECRET_ENV);
                env.remove(MatchingSubmitPort.COMPID_ACCOUNT_JSON_ENV);
            }
            case "dual", "keypair" -> {
                env.put(ServiceKeys.MODE_ENV, config);
                env.put(ServiceKeys.KEYRING_ENV, keyring());
                env.put(ServiceKeys.SIGNING_KID_ENV, "svc-fix.t");
                env.put(ServiceKeys.SIGNING_KEY_ENV,
                        Base64.getUrlEncoder().withoutPadding().encodeToString(
                                pairs.get("svc-fix").getPrivate().getEncoded()));
                if ("keypair".equals(config)) {
                    env.remove(ServiceAuth.SECRET_ENV);
                }
            }
            default -> throw new IllegalArgumentException(config);
        }
        return env;
    }

    /** The public keyring: every per-run key but svc-ops's, which signs as an unknown key. */
    private String keyring() {
        StringBuilder sb = new StringBuilder("{\"keys\":[");
        boolean first = true;
        for (Map.Entry<String, KeyPair> e : pairs.entrySet()) {
            if (e.getKey().equals("svc-ops")) {
                continue;
            }
            byte[] spki = e.getValue().getPublic().getEncoded();
            byte[] raw = java.util.Arrays.copyOfRange(spki, spki.length - 32, spki.length);
            sb.append(first ? "" : ",");
            first = false;
            sb.append("{\"kid\":\"").append(e.getKey()).append(".t\",\"svc\":\"").append(e.getKey());
            sb.append("\",\"use\":\"s2s\",\"x\":\"")
                    .append(Base64.getUrlEncoder().withoutPadding().encodeToString(raw))
                    .append("\"}");
        }
        return sb.append("]}").toString();
    }

    private String hit(int port, String method, String target, String body, String caller) throws Exception {
        String contentType = body == null ? null : "application/json";
        Map<String, String> headers = headers(caller, method, target, body == null ? "" : body, contentType);
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + target))
                .timeout(Duration.ofSeconds(10))
                .method(method, body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (contentType != null) {
            req.header("content-type", contentType);
        }
        headers.forEach(req::header);
        HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        String answer = res.body().replaceAll("\"asOf\":\"[^\"]*\"", "\"asOf\":\"<now>\"");
        return "{\n      \"status\": " + res.statusCode()
                + ",\n      \"contentType\": " + Json.string(res.headers().firstValue("content-type").orElse(""))
                + ",\n      \"body\": " + Json.string(answer) + "\n    }";
    }

    private Map<String, String> headers(String caller, String method, String target, String body, String contentType)
            throws Exception {
        long nowSeconds = Instant.now().getEpochSecond();
        return switch (caller) {
            case "anon" -> Map.of();
            case "hmac-edge-status" -> ServiceAuth.headersForBody(STATUS_SECRET, "svc-edge", body, nowSeconds);
            case "hmac-edge-fleet" -> ServiceAuth.headersForBody(FLEET_SECRET, "svc-edge", body, nowSeconds);
            case "hmac-trade-fleet" -> ServiceAuth.headersForBody(FLEET_SECRET, "svc-trade", body, nowSeconds);
            case "hmac-ledger-fleet" -> ServiceAuth.headersForBody(FLEET_SECRET, "svc-ledger", body, nowSeconds);
            case "hmac-trade-wrong-secret" -> ServiceAuth.headersForBody(WRONG_SECRET, "svc-trade", body, nowSeconds);
            case "hmac-trade-other-body" -> ServiceAuth.headersForBody(FLEET_SECRET, "svc-trade", body + " ", nowSeconds);
            case "hmac-trade-stale" -> ServiceAuth.headersForBody(FLEET_SECRET, "svc-trade", body, nowSeconds - 3600);
            case "key-edge" -> signer("svc-edge").headers("svc-fix", method, target, body, contentType);
            case "key-trade" -> signer("svc-trade").headers("svc-fix", method, target, body, contentType);
            case "key-ledger" -> signer("svc-ledger").headers("svc-fix", method, target, body, contentType);
            case "key-trade-wrong-audience" -> signer("svc-trade").headers("svc-matching", method, target, body, contentType);
            case "key-unknown" -> signer("svc-ops").headers("svc-fix", method, target, body, contentType);
            default -> throw new IllegalArgumentException(caller);
        };
    }

    /** A signer for one caller's per-run key. svc-ops's key is in a keyring only it sees, so svc-fix does not know it. */
    private ServiceKeys.Signer signer(String svc) {
        String pkcs8 = Base64.getUrlEncoder().withoutPadding().encodeToString(pairs.get(svc).getPrivate().getEncoded());
        byte[] spki = pairs.get(svc).getPublic().getEncoded();
        String x = Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString(java.util.Arrays.copyOfRange(spki, spki.length - 32, spki.length));
        List<ServiceKeys.Entry> own = List.of(new ServiceKeys.Entry(svc + ".t", svc, "s2s", x));
        return ServiceKeys.Signer.create(svc, svc + ".t", pkcs8, own, Clock.systemUTC(), new SecureRandom());
    }

    /** The layout {@code JSON.stringify(golden, null, 2)} writes, which the repo's formatter keeps as it is. */
    private static String render(Map<String, String> answers) {
        StringBuilder sb = new StringBuilder("{\n  \"answers\": {\n");
        int i = 0;
        for (Map.Entry<String, String> e : answers.entrySet()) {
            sb.append("    ").append(Json.string(e.getKey())).append(": ").append(e.getValue());
            sb.append(++i < answers.size() ? ",\n" : "\n");
        }
        return sb.append("  }\n}\n").toString();
    }

    private static final String STRING = "\"(?:[^\"\\\\]|\\\\.)*\"";
    private static final Pattern ENTRY = Pattern.compile(
            "^    (" + STRING + "): (\\{\n      \"status\": [0-9]+,\n      \"contentType\": " + STRING
                    + ",\n      \"body\": " + STRING + "\n    \\})",
            Pattern.MULTILINE);

    private static Map<String, String> parse(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        Matcher m = ENTRY.matcher(text);
        while (m.find()) {
            String key = m.group(1);
            out.put(key.substring(1, key.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\"), m.group(2));
        }
        return out;
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        }
    }
}
