package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Per-service key verification (S2S v3) in Java. The vectors were signed by the TypeScript signer in
 * packages/contracts with throwaway keys; Java must verify every one. Negative cases use keys generated per run.
 */
class ServiceKeysTest {
    private static final long NOW = 1_800_000_000L;
    private static final String SELF = "svc-fix";

    private static Clock clockAt(long seconds) {
        return Clock.fixed(Instant.ofEpochSecond(seconds), ZoneOffset.UTC);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> vectors() throws Exception {
        Path file = Path.of("src/test/resources/s2s-v3-vectors.json");
        return (Map<String, Object>) new ServiceKeys.MiniJson(Files.readString(file), true).parseDocument();
    }

    private static Map<String, List<String>> asHeaders(Map<String, Object> raw) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        raw.forEach((k, v) -> out.put(k, List.of((String) v)));
        return out;
    }

    @Test
    @SuppressWarnings("unchecked")
    void javaVerifiesEverySignatureTheTypeScriptSignerMade() throws Exception {
        Map<String, Object> doc = vectors();
        List<ServiceKeys.Entry> keyring = ServiceKeys.parseKeyring(toKeyringJson((Map<String, Object>) doc.get("keyring")));
        List<Object> cases = (List<Object>) doc.get("cases");
        assertTrue(cases.size() >= 4);
        for (Object raw : cases) {
            Map<String, Object> c = (Map<String, Object>) raw;
            ServiceKeys.Verifier verifier = new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW));
            Map<String, Object> expect = (Map<String, Object>) c.get("expect");
            ServiceKeys.Verdict verdict = verifier.verify(
                    (String) c.get("method"),
                    (String) c.get("target"),
                    asHeaders((Map<String, Object>) c.get("headers")),
                    ((String) c.get("body")).getBytes(StandardCharsets.UTF_8));
            assertEquals(ServiceKeys.Status.ACCEPTED, verdict.status(), c.get("name") + ": " + verdict.reason());
            assertEquals(expect.get("service"), verdict.service(), (String) c.get("name"));
            assertEquals(expect.get("kid"), verdict.kid(), (String) c.get("name"));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void aVectorFailsWhenAnyBoundFieldChanges() throws Exception {
        Map<String, Object> doc = vectors();
        List<ServiceKeys.Entry> keyring = ServiceKeys.parseKeyring(toKeyringJson((Map<String, Object>) doc.get("keyring")));
        Map<String, Object> c = (Map<String, Object>) ((List<Object>) doc.get("cases")).get(1);
        Map<String, List<String>> headers = asHeaders((Map<String, Object>) c.get("headers"));
        String method = (String) c.get("method");
        String target = (String) c.get("target");
        byte[] body = ((String) c.get("body")).getBytes(StandardCharsets.UTF_8);
        ServiceKeys.Verifier v = new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW));
        // The decoded forms of the same target are different bytes, so they do not verify.
        assertEquals("bad-signature", v.verify(method, "/internal/a b/é?q=a/b&z=€", headers, body).reason());
        assertEquals("bad-signature", v.verify("GET", target, headers, body).reason());
        assertEquals("body-mismatch", v.verify(method, target, headers, "{\"k\":\"w\"}".getBytes(StandardCharsets.UTF_8)).reason());
        Map<String, List<String>> otherType = new LinkedHashMap<>(headers);
        otherType.put("content-type", List.of("text/plain"));
        assertEquals("bad-signature", v.verify(method, target, otherType, body).reason());
        assertEquals("body-unavailable", v.verify(method, target, headers, null).reason());
        assertEquals(ServiceKeys.Status.ACCEPTED, v.verify(method, target, headers, body).status());
        assertEquals("replay", v.verify(method, target, headers, body).reason());
    }

    @Test
    @SuppressWarnings("unchecked")
    void staleFutureWrongAudienceAndPartialHeadersAreRefused() throws Exception {
        Map<String, Object> doc = vectors();
        List<ServiceKeys.Entry> keyring = ServiceKeys.parseKeyring(toKeyringJson((Map<String, Object>) doc.get("keyring")));
        Map<String, Object> c = (Map<String, Object>) ((List<Object>) doc.get("cases")).get(0);
        Map<String, List<String>> headers = asHeaders((Map<String, Object>) c.get("headers"));
        String method = (String) c.get("method");
        String target = (String) c.get("target");
        byte[] body = ((String) c.get("body")).getBytes(StandardCharsets.UTF_8);
        MovableClock moving = new MovableClock(NOW);
        ServiceKeys.Verifier verifier = new ServiceKeys.Verifier(SELF, keyring, moving);
        moving.set(NOW + 61);
        assertEquals("stale", verifier.verify(method, target, headers, body).reason());
        assertEquals("stale", new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW - 6)).verify(method, target, headers, body).reason());
        assertEquals("wrong-audience", new ServiceKeys.Verifier("svc-ops", keyring, clockAt(NOW)).verify(method, target, headers, body).reason());
        Map<String, List<String>> partial = new LinkedHashMap<>(headers);
        partial.remove(ServiceKeys.NONCE_HEADER);
        assertEquals("malformed", new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW)).verify(method, target, partial, body).reason());
        Map<String, List<String>> dup = new LinkedHashMap<>(headers);
        dup.put(ServiceKeys.KID_HEADER, List.of("svc-trade.v1", "svc-trade.v1"));
        assertEquals("malformed", new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW)).verify(method, target, dup, body).reason());
        Map<String, List<String>> joined = new LinkedHashMap<>(headers);
        joined.put(ServiceKeys.KID_HEADER, List.of("svc-trade.v1, svc-trade.v1"));
        assertEquals("malformed", new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW)).verify(method, target, joined, body).reason());
        Map<String, List<String>> unknown = new LinkedHashMap<>(headers);
        unknown.put(ServiceKeys.KID_HEADER, List.of("svc-trade.v9"));
        assertEquals("unknown-key", new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW)).verify(method, target, unknown, body).reason());
        assertEquals(
                ServiceKeys.Status.ABSENT,
                new ServiceKeys.Verifier(SELF, keyring, clockAt(NOW)).verify(method, target, Map.of(), body).status());
    }

    @Test
    void keysGeneratedPerRunSignAndVerifyAndAnotherKeyCannotImpersonate() throws Exception {
        TestKey trade = TestKey.generate("svc-trade");
        TestKey ops = TestKey.generate("svc-ops");
        List<ServiceKeys.Entry> keyring = List.of(trade.entry, ops.entry);
        Clock clock = clockAt(NOW);
        ServiceKeys.Verifier v = new ServiceKeys.Verifier(SELF, keyring, clock);
        byte[] body = "{\"a\":1}".getBytes(StandardCharsets.UTF_8);
        Map<String, List<String>> good = trade.sign(SELF, "POST", "/internal/drop-copy/fills", body, "application/json", NOW);
        ServiceKeys.Verdict ok = v.verify("POST", "/internal/drop-copy/fills", good, body);
        assertEquals(ServiceKeys.Status.ACCEPTED, ok.status());
        assertEquals("svc-trade", ok.service());
        // A key signing under another service's kid does not verify.
        Map<String, List<String>> forged = ops.signAs(trade.entry.kid(), SELF, "POST", "/internal/drop-copy/fills", body, "application/json", NOW);
        assertEquals("bad-signature", v.verify("POST", "/internal/drop-copy/fills", forged, body).reason());
    }

    @Test
    void keyringRefusesPrivateMaterialAndMalformedEntries() throws Exception {
        TestKey a = TestKey.generate("svc-trade");
        String entry = "{\"kid\":\"" + a.entry.kid() + "\",\"svc\":\"svc-trade\",\"use\":\"s2s\",\"x\":\"" + a.entry.x() + "\"}";
        assertEquals(1, ServiceKeys.parseKeyring("{\"keys\":[" + entry + "]}").size());
        for (String bad : List.of(
                "not json",
                "{\"keys\":[{\"kid\":\"svc-trade.a\",\"svc\":\"svc-trade\",\"use\":\"s2s\",\"x\":\"" + a.entry.x() + "\",\"d\":\"secret\"}]}",
                "{\"keys\":[{\"kid\":\"svc-ops.a\",\"svc\":\"svc-trade\",\"use\":\"s2s\",\"x\":\"" + a.entry.x() + "\"}]}",
                "{\"keys\":[{\"kid\":\"svc-nope.a\",\"svc\":\"svc-nope\",\"use\":\"s2s\",\"x\":\"" + a.entry.x() + "\"}]}",
                "{\"keys\":[{\"kid\":\"svc-trade.a\",\"svc\":\"svc-trade\",\"use\":\"s2s\",\"x\":\"short\"}]}",
                "{\"keys\":[" + entry + "," + entry + "]}",
                "{\"keys\":[]} trailing")) {
            assertThrows(ServiceKeys.KeyError.class, () -> ServiceKeys.parseKeyring(bad), bad);
        }
    }

    @Test
    void envOffOrUnsetKeepsTheSharedSecretAndBadValuesStopBoot() {
        assertNull(ServiceKeys.inboundFromEnv(Map.of(), SELF));
        assertNull(ServiceKeys.inboundFromEnv(Map.of("S2S_AUTH_MODE", "off"), SELF));
        assertThrows(ServiceKeys.KeyError.class, () -> ServiceKeys.inboundFromEnv(Map.of("S2S_AUTH_MODE", "Dual"), SELF));
        assertThrows(ServiceKeys.KeyError.class, () -> ServiceKeys.inboundFromEnv(Map.of("S2S_AUTH_MODE", "dual"), SELF));
        assertThrows(
                ServiceKeys.KeyError.class,
                () -> ServiceKeys.inboundFromEnv(Map.of("S2S_AUTH_MODE", "keypair", "S2S_KEYRING", "{\"keys\":\"x\"}"), SELF));
    }

    @Test
    void dropCopyIngestAcceptsOnlySvcTradeByKeyAndKeypairRefusesTheSharedSecret() throws Exception {
        TestKey trade = TestKey.generate("svc-trade");
        TestKey ops = TestKey.generate("svc-ops");
        List<ServiceKeys.Entry> keyring = List.of(trade.entry, ops.entry);
        String fill =
                "{\"fillId\":\"fill-7\",\"orderId\":\"ord-1\",\"userId\":\"user-1\",\"marketId\":\"BTC/USDT\",\"side\":\"buy\",\"price\":\"100.25\",\"qty\":\"1.50\",\"quoteAmount\":\"150.375\",\"feeAsset\":\"USDT\",\"feeAmount\":\"0.15\",\"sequence\":11,\"ts\":\"2026-09-18T00:00:00Z\",\"source\":\"rest\"}";
        String secret = "a".repeat(32);
        for (String mode : List.of("dual", "keypair")) {
            // Signed no earlier than the verifier booted (a call signed before boot is stale by design).
            long now = Instant.now().getEpochSecond();
            ServiceKeys.Inbound s2s = new ServiceKeys.Inbound(new ServiceKeys.Verifier(SELF, keyring, Clock.systemUTC()), mode);
            int port;
            try (java.net.ServerSocket probe = new java.net.ServerSocket(0)) {
                port = probe.getLocalPort();
            }
            DropCopyIngest.Result started =
                    DropCopyIngest.start(port, quickfix.FixVersions.BEGINSTRING_FIX44, secret, new DropCopyHub(), s2s);
            assertTrue(started.ok, started.errorMessage);
            try (DropCopyIngest ignored = started.ingest) {
                String url = "http://127.0.0.1:" + port + DropCopyIngest.PATH;
                byte[] bytes = fill.getBytes(StandardCharsets.UTF_8);
                // svc-trade by key: accepted past auth (a fill with no hub listener still answers 200 or a named refusal, never 401/403)
                int viaKey = post(url, bytes, trade.sign(SELF, "POST", DropCopyIngest.PATH, bytes, "application/json", now));
                assertTrue(viaKey != 401 && viaKey != 403, mode + " key status " + viaKey);
                // another service's valid key: 403
                assertEquals(403, post(url, bytes, ops.sign(SELF, "POST", DropCopyIngest.PATH, bytes, "application/json", now)));
                // a replay of the accepted call: 401
                Map<String, List<String>> once = trade.sign(SELF, "POST", DropCopyIngest.PATH, bytes, "application/json", now);
                post(url, bytes, once);
                assertEquals(401, post(url, bytes, once));
                // a key-signed call for other bytes never falls back to the secret it also carries
                Map<String, List<String>> both = new LinkedHashMap<>(
                        trade.sign(SELF, "POST", DropCopyIngest.PATH, "{}".getBytes(StandardCharsets.UTF_8), "application/json", now));
                ServiceAuth.headersForBody(secret, fill).forEach((k, v) -> both.put(k, List.of(v)));
                assertEquals(401, post(url, bytes, both));
                // the shared secret alone: dual accepts, keypair refuses
                Map<String, List<String>> legacy = new LinkedHashMap<>();
                ServiceAuth.headersForBody(secret, fill).forEach((k, v) -> legacy.put(k, List.of(v)));
                int viaSecret = post(url, bytes, legacy);
                if (mode.equals("keypair")) {
                    assertEquals(401, viaSecret);
                } else {
                    assertTrue(viaSecret != 401 && viaSecret != 403, "dual secret status " + viaSecret);
                }
            }
        }
    }

    @Test
    void keypairStartsWithoutASharedSecretAndDualDoesNot() throws Exception {
        TestKey trade = TestKey.generate("svc-trade");
        for (String mode : List.of("keypair", "dual")) {
            ServiceKeys.Inbound s2s =
                    new ServiceKeys.Inbound(new ServiceKeys.Verifier(SELF, List.of(trade.entry), Clock.systemUTC()), mode);
            DropCopyIngest.Result r = DropCopyIngest.start(19311, quickfix.FixVersions.BEGINSTRING_FIX44, "", new DropCopyHub(), s2s);
            assertEquals(mode.equals("keypair"), r.ok, mode);
            if (r.ok) {
                r.ingest.close();
            }
        }
    }

    private static int post(String url, byte[] body, Map<String, List<String>> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).POST(HttpRequest.BodyPublishers.ofByteArray(body));
        b.header("content-type", "application/json");
        headers.forEach((k, v) -> {
            if (!k.equalsIgnoreCase("content-type")) {
                v.forEach(value -> b.header(k, value));
            }
        });
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    @SuppressWarnings("unchecked")
    private static String toKeyringJson(Map<String, Object> keyring) {
        StringBuilder sb = new StringBuilder("{\"keys\":[");
        List<Object> keys = (List<Object>) keyring.get("keys");
        for (int i = 0; i < keys.size(); i++) {
            Map<String, Object> k = (Map<String, Object>) keys.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"kid\":\"").append(k.get("kid")).append("\",\"svc\":\"").append(k.get("svc"))
                    .append("\",\"use\":\"").append(k.get("use")).append("\",\"x\":\"").append(k.get("x")).append("\"}");
        }
        return sb.append("]}").toString();
    }

    private static final class MovableClock extends Clock {
        private long seconds;

        MovableClock(long seconds) {
            this.seconds = seconds;
        }

        void set(long seconds) {
            this.seconds = seconds;
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return Instant.ofEpochSecond(seconds);
        }
    }

    /** Test-only signer. It builds the preimage with the production helpers, so it is byte-checked by the vectors. */
    private static final class TestKey {
        final KeyPair pair;
        final ServiceKeys.Entry entry;

        private TestKey(KeyPair pair, ServiceKeys.Entry entry) {
            this.pair = pair;
            this.entry = entry;
        }

        static TestKey generate(String service) throws Exception {
            KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            byte[] spki = pair.getPublic().getEncoded();
            byte[] raw = java.util.Arrays.copyOfRange(spki, spki.length - 32, spki.length);
            String x = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
            return new TestKey(pair, new ServiceKeys.Entry(service + ".t", service, "s2s", x));
        }

        Map<String, List<String>> sign(String aud, String method, String target, byte[] body, String contentType, long ts)
                throws Exception {
            return signAs(entry.kid(), aud, method, target, body, contentType, ts);
        }

        Map<String, List<String>> signAs(
                String kid, String aud, String method, String target, byte[] body, String contentType, long ts)
                throws Exception {
            byte[] nonceBytes = new byte[16];
            new SecureRandom().nextBytes(nonceBytes);
            String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes);
            String digest = ServiceKeys.sha256Hex(body);
            String ctx = ServiceKeys.contextDigest(null, null, null, contentType);
            byte[] message = ServiceKeys.preimage(kid, aud, method, target, Long.toString(ts), nonce, digest, ctx);
            Signature s = Signature.getInstance("Ed25519");
            s.initSign(pair.getPrivate());
            s.update(message);
            Map<String, List<String>> h = new LinkedHashMap<>();
            h.put(ServiceKeys.KID_HEADER, List.of(kid));
            h.put(ServiceKeys.AUDIENCE_HEADER, List.of(aud));
            h.put(ServiceKeys.TIMESTAMP_HEADER, List.of(Long.toString(ts)));
            h.put(ServiceKeys.NONCE_HEADER, List.of(nonce));
            h.put(ServiceKeys.BODY_HEADER, List.of(digest));
            h.put(ServiceKeys.SIGNATURE_HEADER, List.of(Base64.getUrlEncoder().withoutPadding().encodeToString(s.sign())));
            h.put("content-type", new ArrayList<>(List.of(contentType)));
            return h;
        }
    }
}
