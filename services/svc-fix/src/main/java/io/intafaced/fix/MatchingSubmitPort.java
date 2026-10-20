package io.intafaced.fix;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A5/A6 matching HTTP from the live session. CompID map + TIF before POST.
 * Named ack only. No ledger. Never invent an account, last, or fill.
 */
public final class MatchingSubmitPort {
    public static final String BASE_URL_ENV = "MATCHING_BASE_URL";
    public static final String COMPID_ACCOUNT_JSON_ENV = "FIX_COMPID_ACCOUNT_JSON";
    public static final String SERVICE_SECRET_ENV = ServiceAuth.SECRET_ENV;
    public static final String AUDIENCE = "svc-matching";
    static final String CONTENT_TYPE_JSON = "application/json";
    private static final Duration TIMEOUT = Duration.ofSeconds(5);

    public interface Transport {
        Response post(String url, String json, Map<String, String> headers) throws Exception;

        record Response(int status, String body) {}
    }

    private final String matchingBaseUrl;
    private final String compIdAccountJson;
    private final String internalServiceSecret;
    private final ServiceKeys.Outbound outbound;
    private final Transport transport;

    public MatchingSubmitPort(String matchingBaseUrl, String compIdAccountJson, Transport transport) {
        this(matchingBaseUrl, compIdAccountJson, null, transport);
    }

    public MatchingSubmitPort(
            String matchingBaseUrl, String compIdAccountJson, String internalServiceSecret, Transport transport) {
        this(matchingBaseUrl, compIdAccountJson, internalServiceSecret, null, transport);
    }

    /**
     * @param outbound the per-service signing key and mode (S2S v3), or null for the shared secret alone. In
     *     {@code dual} the shared secret rides along; in {@code keypair} the key signature is the only form and the
     *     shared secret may be blank.
     */
    public MatchingSubmitPort(
            String matchingBaseUrl,
            String compIdAccountJson,
            String internalServiceSecret,
            ServiceKeys.Outbound outbound,
            Transport transport) {
        this.matchingBaseUrl = matchingBaseUrl;
        this.compIdAccountJson = compIdAccountJson;
        this.internalServiceSecret = internalServiceSecret;
        this.outbound = outbound;
        this.transport = transport;
    }

    public static MatchingSubmitPort fromEnv() {
        return fromEnv(System.getenv());
    }

    public static MatchingSubmitPort fromEnv(Map<String, String> env) {
        return new MatchingSubmitPort(
                env.get(BASE_URL_ENV),
                env.get(COMPID_ACCOUNT_JSON_ENV),
                env.get(SERVICE_SECRET_ENV),
                ServiceKeys.outboundFromEnv(env, ServiceAuth.SERVICE_NAME),
                jdkTransport());
    }

    public MatchingSubmitResult submit(MatchingOrderCommand command) {
        if (command.tif == null || command.tif.isBlank()) {
            return MatchingSubmitResult.refuse("tif_missing", "TimeInForce is missing; svc-fix does not invent GTC", false);
        }
        Map<String, String> map = readCompIdAccountMap(compIdAccountJson);
        if (map == null) {
            return MatchingSubmitResult.refuse(
                    "matching_account_unmapped",
                    "FIX_COMPID_ACCOUNT_JSON is blank; svc-fix does not invent an account",
                    false);
        }
        String compId = command.senderCompId == null ? "" : command.senderCompId.trim();
        if (compId.isEmpty()) {
            return MatchingSubmitResult.refuse(
                    "matching_account_unmapped", "SenderCompID is blank; svc-fix does not invent an account", false);
        }
        String accountId = map.get(compId);
        if (accountId == null) {
            return MatchingSubmitResult.refuse(
                    "matching_account_unmapped",
                    "SenderCompID " + compId + " is unmapped; svc-fix does not invent an account",
                    false);
        }
        String base = matchingBaseUrl == null ? "" : matchingBaseUrl.trim().replaceAll("/$", "");
        if (base.isEmpty()) {
            return MatchingSubmitResult.refuse(
                    "matching_unconfigured",
                    "MATCHING_BASE_URL is blank; svc-fix does not invent a matching host, a last price, or a fill",
                    false);
        }
        String secret = internalServiceSecret == null ? "" : internalServiceSecret;
        boolean keypairOnly = outbound != null && outbound.keypairOnly();
        if (!keypairOnly && !ServiceAuth.secretReady(secret)) {
            return MatchingSubmitResult.refuse(
                    "matching_service_auth_unconfigured",
                    "INTERNAL_SERVICE_SECRET is blank; svc-fix does not POST unsigned matching orders",
                    false);
        }
        String path = "/markets/" + URLEncoder.encode(command.symbol, StandardCharsets.UTF_8).replace("+", "%20") + "/orders";
        String body = submitJson(command, accountId);
        String url = base + path;
        Map<String, String> headers = new LinkedHashMap<>();
        if (outbound != null) {
            URI uri = URI.create(url);
            String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
            headers.putAll(outbound.signer().headers(AUDIENCE, "POST", target, body, CONTENT_TYPE_JSON));
        }
        if (!keypairOnly) {
            headers.putAll(ServiceAuth.headersForBody(secret, body));
        }
        Transport.Response response;
        try {
            response = transport.post(url, body, headers);
        } catch (Exception e) {
            String detail = e.getMessage() == null ? "unknown" : e.getMessage();
            return MatchingSubmitResult.refuse(
                    "matching_unavailable",
                    "matching submit unreachable: " + detail + "; svc-fix does not invent a fill",
                    true);
        }
        if (response.status() == 408 || response.status() == 504) {
            return MatchingSubmitResult.refuse(
                    "matching_timeout",
                    "matching submit timed out (" + response.status() + "); svc-fix does not invent a fill",
                    true);
        }
        if (response.status() >= 500) {
            return MatchingSubmitResult.refuse(
                    "matching_unavailable",
                    "matching submit failed (" + response.status() + "); svc-fix does not invent a fill",
                    true);
        }
        if (response.status() < 200 || response.status() >= 300) {
            return MatchingSubmitResult.refuse(
                    "matching_rejected",
                    "matching rejected submit (" + response.status() + "); svc-fix does not invent a fill",
                    true);
        }
        return parseAck(response.body(), true);
    }

    static MatchingSubmitResult parseAck(String raw, boolean httpSent) {
        if (raw == null || raw.isBlank()) {
            return MatchingSubmitResult.refuse(
                    "matching_rejected", "matching submit ack is not named accepted/sequence JSON; svc-fix does not mint fills, last, or account", httpSent);
        }
        String text = raw.trim();
        if (text.contains("\"accepted\":false") || text.contains("\"accepted\": false")) {
            return MatchingSubmitResult.refuse(
                    "matching_rejected", "matching rejected the order; svc-fix does not invent a fill", httpSent);
        }
        if (!(text.contains("\"accepted\":true") || text.contains("\"accepted\": true"))) {
            return MatchingSubmitResult.refuse(
                    "matching_rejected",
                    "matching submit ack is not named accepted/sequence JSON; svc-fix does not mint fills, last, or account",
                    httpSent);
        }
        Long sequence = readIntegerSequence(text);
        if (sequence == null && hasSequenceField(text) && !sequenceIsNull(text)) {
            return MatchingSubmitResult.refuse(
                    "matching_rejected",
                    "matching sequence is not an integer; svc-fix does not treat IEEE last as money",
                    httpSent);
        }
        return MatchingSubmitResult.accepted(new MatchingAck(true, sequence), httpSent);
    }

    static String submitJson(MatchingOrderCommand command, String accountId) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        sb.append("\"orderId\":").append(Json.string(command.clOrdId));
        sb.append(",\"accountId\":").append(Json.string(accountId));
        sb.append(",\"type\":").append(Json.string(command.ordType));
        sb.append(",\"side\":").append(Json.string(command.side));
        sb.append(",\"qty\":").append(Json.string(command.qty));
        sb.append(",\"price\":");
        if (command.price == null) {
            sb.append("null");
        } else {
            sb.append(Json.string(command.price));
        }
        sb.append(",\"tif\":").append(Json.string(command.tif));
        sb.append('}');
        return sb.toString();
    }

    static Map<String, String> readCompIdAccountMap(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) {
            return null;
        }
        if (!text.startsWith("{") || !text.endsWith("}")) {
            return null;
        }
        Map<String, String> map = new LinkedHashMap<>();
        String inner = text.substring(1, text.length() - 1).trim();
        if (inner.isEmpty()) {
            return null;
        }
        int i = 0;
        while (i < inner.length()) {
            int keyStart = inner.indexOf('"', i);
            if (keyStart < 0) {
                break;
            }
            int keyEnd = inner.indexOf('"', keyStart + 1);
            if (keyEnd < 0) {
                break;
            }
            String key = inner.substring(keyStart + 1, keyEnd).trim();
            int colon = inner.indexOf(':', keyEnd + 1);
            if (colon < 0) {
                break;
            }
            int valStart = inner.indexOf('"', colon + 1);
            if (valStart < 0) {
                break;
            }
            int valEnd = inner.indexOf('"', valStart + 1);
            if (valEnd < 0) {
                break;
            }
            String value = inner.substring(valStart + 1, valEnd).trim();
            if (!key.isEmpty() && !value.isEmpty()) {
                map.put(key, value);
            }
            i = valEnd + 1;
        }
        return map.isEmpty() ? null : map;
    }

    private static boolean hasSequenceField(String text) {
        return text.contains("\"sequence\"");
    }

    private static boolean sequenceIsNull(String text) {
        return text.contains("\"sequence\":null") || text.contains("\"sequence\": null");
    }

    private static Long readIntegerSequence(String text) {
        int key = text.indexOf("\"sequence\"");
        if (key < 0) {
            return null;
        }
        int colon = text.indexOf(':', key);
        if (colon < 0) {
            return null;
        }
        int i = colon + 1;
        while (i < text.length() && Character.isWhitespace(text.charAt(i))) {
            i++;
        }
        if (i < text.length() && text.startsWith("null", i)) {
            return null;
        }
        int start = i;
        if (i < text.length() && (text.charAt(i) == '-' || text.charAt(i) == '+')) {
            i++;
        }
        while (i < text.length() && Character.isDigit(text.charAt(i))) {
            i++;
        }
        if (start == i || (i < text.length() && (text.charAt(i) == '.' || text.charAt(i) == 'e' || text.charAt(i) == 'E'))) {
            return null;
        }
        try {
            return Long.parseLong(text.substring(start, i));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Transport jdkTransport() {
        HttpClient client = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
        return (url, json, headers) -> {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                    .timeout(TIMEOUT)
                    .header("content-type", CONTENT_TYPE_JSON)
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
            for (Map.Entry<String, String> header : headers.entrySet()) {
                builder.header(header.getKey(), header.getValue());
            }
            HttpResponse<String> response =
                    client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Transport.Response(response.statusCode(), response.body());
        };
    }
}
