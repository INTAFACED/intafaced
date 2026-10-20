package io.intafaced.fix;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * v2 S2S headers matching {@code serviceAuthHeadersForBody} in @intafaced/contracts.
 * Outbound matching signs as svc-fix. Inbound ingest verifies any named caller.
 * Ingest body-bind is hardcoded {@code require}, not the compose accept-both default.
 * Secret is INTERNAL_SERVICE_SECRET. Never unsigned.
 */
public final class ServiceAuth {
    public static final String SERVICE_NAME = "svc-fix";
    public static final String SECRET_ENV = "INTERNAL_SERVICE_SECRET";
    public static final String SERVICE_HEADER = "x-intafaced-service";
    public static final String SERVICE_TIMESTAMP_HEADER = "x-intafaced-service-ts";
    public static final String SERVICE_SIGNATURE_HEADER = "x-intafaced-service-sig";
    public static final String SERVICE_BODY_DIGEST_HEADER = "x-intafaced-service-body";
    public static final int MIN_SECRET_LENGTH = 32;
    /** Matches contracts SERVICE_CALL_MAX_SKEW_SECONDS. */
    public static final int MAX_SKEW_SECONDS = 300;
    /** Hardcoded ingest verifier mode. Not the compose accept-both default. */
    public static final String BODY_BIND_REQUIRE = "require";
    private static final String V2_DOMAIN = "intafaced-s2s-v2";
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private ServiceAuth() {}

    public static boolean secretReady(String secret) {
        return secret != null && secret.length() >= MIN_SECRET_LENGTH;
    }

    public static Map<String, String> headersForBody(String secret, String body) {
        return headersForBody(secret, SERVICE_NAME, body, Instant.now().getEpochSecond());
    }

    public static Map<String, String> headersForBody(String secret, String body, long timestampSeconds) {
        return headersForBody(secret, SERVICE_NAME, body, timestampSeconds);
    }

    public static Map<String, String> headersForBody(
            String secret, String service, String body, long timestampSeconds) {
        String name = service == null || service.isBlank() ? SERVICE_NAME : service;
        String digest = sha256Hex(body == null ? "" : body);
        String preimage = serviceCallPreimage(name, timestampSeconds, digest);
        String signature = hmacSha256Hex(secret, preimage);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put(SERVICE_HEADER, name);
        headers.put(SERVICE_TIMESTAMP_HEADER, Long.toString(timestampSeconds));
        headers.put(SERVICE_BODY_DIGEST_HEADER, digest);
        headers.put(SERVICE_SIGNATURE_HEADER, signature);
        return headers;
    }

    /**
     * Body-bind {@link #BODY_BIND_REQUIRE} on the exact raw bytes. Blank secret refuses.
     */
    public static VerifyResult verifyServiceHeaders(
            Map<String, ? extends List<String>> headers, String secret, String rawBody, Instant now) {
        return verifyServiceCall(
                header(headers, SERVICE_HEADER),
                header(headers, SERVICE_TIMESTAMP_HEADER),
                header(headers, SERVICE_SIGNATURE_HEADER),
                header(headers, SERVICE_BODY_DIGEST_HEADER),
                secret,
                rawBody,
                now);
    }

    public static VerifyResult verifyServiceCall(
            String service,
            String timestamp,
            String signature,
            String bodyDigest,
            String secret,
            String rawBody,
            Instant now) {
        if (!secretReady(secret)) {
            return VerifyResult.reject("missing");
        }
        if (blank(service) || blank(timestamp) || blank(signature)) {
            return VerifyResult.reject("missing");
        }
        long ts;
        try {
            ts = Long.parseLong(timestamp.trim());
        } catch (NumberFormatException e) {
            return VerifyResult.reject("missing");
        }
        Instant clock = now == null ? Instant.now() : now;
        long skew = Math.abs(clock.getEpochSecond() - ts);
        if (skew > MAX_SKEW_SECONDS) {
            return VerifyResult.reject("stale");
        }
        if (bodyDigest == null || bodyDigest.isEmpty()) {
            String v1 = hmacSha256Hex(secret, service + '\n' + ts);
            if (!hexEquals(signature, v1)) {
                return VerifyResult.reject("bad-signature");
            }
            return VerifyResult.reject("missing-body-digest");
        }
        if (!bodyDigest.matches("[0-9a-f]{64}")) {
            return VerifyResult.reject("bad-signature");
        }
        String expected = hmacSha256Hex(secret, serviceCallPreimage(service, ts, bodyDigest));
        if (!hexEquals(signature, expected)) {
            return VerifyResult.reject("bad-signature");
        }
        if (rawBody == null) {
            return VerifyResult.reject("body-unavailable");
        }
        if (!hexEquals(sha256Hex(rawBody), bodyDigest)) {
            return VerifyResult.reject("body-mismatch");
        }
        return VerifyResult.accept(service, "v2");
    }

    public static final class VerifyResult {
        public final String service;
        public final String rejected;
        public final String scheme;

        private VerifyResult(String service, String rejected, String scheme) {
            this.service = service;
            this.rejected = rejected;
            this.scheme = scheme;
        }

        public boolean ok() {
            return service != null && rejected == null;
        }

        static VerifyResult reject(String reason) {
            return new VerifyResult(null, reason, null);
        }

        static VerifyResult accept(String service, String scheme) {
            return new VerifyResult(service, null, scheme);
        }
    }

    static String serviceCallPreimage(String service, long timestampSeconds, String bodyDigest) {
        return V2_DOMAIN
                + '\n'
                + lengthPrefixed(service)
                + lengthPrefixed(Long.toString(timestampSeconds))
                + lengthPrefixed(bodyDigest);
    }

    static String lengthPrefixed(String value) {
        int bytes = value.getBytes(StandardCharsets.UTF_8).length;
        return bytes + ":" + value + '\n';
    }

    static String sha256Hex(String body) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return hex(digest.digest(body.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    static String hmacSha256Hex(String secret, String preimage) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(preimage.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    private static String header(Map<String, ? extends List<String>> headers, String name) {
        if (headers == null || name == null) {
            return null;
        }
        List<String> values = headers.get(name);
        if (values == null) {
            for (Map.Entry<String, ? extends List<String>> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().toLowerCase(Locale.ROOT).equals(name)) {
                    values = entry.getValue();
                    break;
                }
            }
        }
        if (values == null || values.isEmpty()) {
            return null;
        }
        String value = values.get(0);
        return value == null || value.isBlank() ? null : value;
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    static boolean hexEquals(String actual, String expected) {
        if (actual == null || expected == null || actual.length() != expected.length()) {
            return false;
        }
        if (!actual.matches("[0-9a-f]+")) {
            return false;
        }
        return MessageDigest.isEqual(
                actual.getBytes(StandardCharsets.US_ASCII), expected.getBytes(StandardCharsets.US_ASCII));
    }

    private static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xff;
            out[i * 2] = HEX[v >>> 4];
            out[i * 2 + 1] = HEX[v & 0x0f];
        }
        return new String(out);
    }
}
