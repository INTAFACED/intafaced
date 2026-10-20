package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * svc-fix's outgoing matching submit signed with its own Ed25519 key (S2S v3), judged by the Java verifier that is
 * itself held to the TypeScript vectors (ServiceKeysTest). The TypeScript contracts verifier judges the output of the
 * real submit path in src/matching-port-java-keys.test.ts. Keys are generated per run; none is stored.
 */
class MatchingSubmitPortKeysTest {
    private static final String OWNER_MAP = "{\"CLIENT\":\"acct-desk\"}";
    private static final String SECRET = "a".repeat(32);
    private static final long NOW = 1_900_000_000L;
    private static final Clock CLOCK = Clock.fixed(Instant.ofEpochSecond(NOW), ZoneOffset.UTC);

    private final MatchingOrderCommand limit = new MatchingOrderCommand(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "FIX.4.4",
            null,
            "BTC/USDT",
            "buy",
            "limit",
            "1.50",
            "100.25",
            "CLIENT",
            "GTC");

    private record Keys(ServiceKeys.Outbound dual, ServiceKeys.Outbound keypair, ServiceKeys.Verifier verifier) {}

    private static Keys keys() throws Exception {
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] spki = pair.getPublic().getEncoded();
        byte[] raw = new byte[32];
        System.arraycopy(spki, spki.length - 32, raw, 0, 32);
        String x = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        String pkcs8 = Base64.getUrlEncoder().withoutPadding().encodeToString(pair.getPrivate().getEncoded());
        List<ServiceKeys.Entry> ring = List.of(new ServiceKeys.Entry("svc-fix.a", "svc-fix", "s2s", x));
        ServiceKeys.Signer signer =
                ServiceKeys.Signer.create("svc-fix", "svc-fix.a", pkcs8, ring, CLOCK, new SecureRandom());
        return new Keys(
                new ServiceKeys.Outbound(signer, "dual"),
                new ServiceKeys.Outbound(signer, "keypair"),
                new ServiceKeys.Verifier("svc-matching", ring, Clock.fixed(Instant.ofEpochSecond(NOW), ZoneOffset.UTC)));
    }

    private static Map<String, List<String>> asHeaders(Map<String, String> flat) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        flat.forEach((k, v) -> out.put(k, List.of(v)));
        return out;
    }

    private static final class Wire {
        final AtomicReference<String> url = new AtomicReference<>();
        final AtomicReference<String> body = new AtomicReference<>();
        final AtomicReference<Map<String, String>> headers = new AtomicReference<>();

        MatchingSubmitPort.Transport transport() {
            return (u, b, h) -> {
                url.set(u);
                body.set(b);
                headers.set(h);
                return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
            };
        }

        String target() {
            URI uri = URI.create(url.get());
            return uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        }

        Map<String, String> withContentType() {
            Map<String, String> all = new LinkedHashMap<>(headers.get());
            all.put("content-type", MatchingSubmitPort.CONTENT_TYPE_JSON);
            return all;
        }
    }

    private MatchingSubmitPort port(String secret, ServiceKeys.Outbound outbound, Wire wire) {
        return new MatchingSubmitPort("http://matching.example", OWNER_MAP, secret, outbound, wire.transport());
    }

    @Test
    void offSendsTheSharedSecretAloneAsBefore() {
        Wire wire = new Wire();
        MatchingSubmitResult result = port(SECRET, null, wire).submit(limit);
        assertTrue(result.ok, result.errorMessage);
        assertFalse(wire.headers.get().containsKey(ServiceKeys.KID_HEADER));
        assertEquals("svc-fix", wire.headers.get().get(ServiceAuth.SERVICE_HEADER));
    }

    @Test
    void offStillRefusesABlankOrShortSecretBeforeAnyPost() {
        for (String secret : new String[] {"", "short", null}) {
            Wire wire = new Wire();
            MatchingSubmitResult result = port(secret, null, wire).submit(limit);
            assertFalse(result.ok);
            assertFalse(result.httpSent);
            assertEquals("matching_service_auth_unconfigured", result.errorCode);
            assertNull(wire.url.get());
        }
    }

    @Test
    void dualSendsTheKeySignatureAndTheV2HmacAndTheJavaVerifierAcceptsIt() throws Exception {
        Keys k = keys();
        Wire wire = new Wire();
        MatchingSubmitResult result = port(SECRET, k.dual(), wire).submit(limit);
        assertTrue(result.ok, result.errorMessage);
        Map<String, String> sent = wire.headers.get();
        assertEquals("svc-matching", sent.get(ServiceKeys.AUDIENCE_HEADER));
        assertEquals("svc-fix.a", sent.get(ServiceKeys.KID_HEADER));
        assertEquals("svc-fix", sent.get(ServiceAuth.SERVICE_HEADER));
        assertTrue(sent.get(ServiceAuth.SERVICE_SIGNATURE_HEADER).matches("[0-9a-f]{64}"));
        ServiceKeys.Verdict verdict = k.verifier()
                .verify("POST", wire.target(), asHeaders(wire.withContentType()), wire.body.get().getBytes());
        assertEquals(ServiceKeys.Status.ACCEPTED, verdict.status(), verdict.reason());
        assertEquals("svc-fix", verdict.service());
    }

    @Test
    void dualStillRefusesABlankSecret() throws Exception {
        Wire wire = new Wire();
        MatchingSubmitResult result = port("", keys().dual(), wire).submit(limit);
        assertFalse(result.ok);
        assertEquals("matching_service_auth_unconfigured", result.errorCode);
        assertNull(wire.url.get());
    }

    @Test
    void keypairSendsOnlyTheKeySignatureAndNeedsNoSharedSecret() throws Exception {
        Keys k = keys();
        Wire wire = new Wire();
        MatchingSubmitResult result = port("", k.keypair(), wire).submit(limit);
        assertTrue(result.ok, result.errorMessage);
        Map<String, String> sent = wire.headers.get();
        assertFalse(sent.containsKey(ServiceAuth.SERVICE_HEADER));
        assertFalse(sent.containsKey(ServiceAuth.SERVICE_SIGNATURE_HEADER));
        assertFalse(sent.containsKey(ServiceAuth.SERVICE_TIMESTAMP_HEADER));
        assertFalse(sent.containsKey(ServiceAuth.SERVICE_BODY_DIGEST_HEADER));
        ServiceKeys.Verdict verdict = k.verifier()
                .verify("POST", wire.target(), asHeaders(wire.withContentType()), wire.body.get().getBytes());
        assertEquals(ServiceKeys.Status.ACCEPTED, verdict.status(), verdict.reason());
    }

    @Test
    void aCallMovedToAnotherPathMethodBodyOrContentTypeIsRefused() throws Exception {
        Keys k = keys();
        Wire wire = new Wire();
        assertTrue(port("", k.keypair(), wire).submit(limit).ok);
        Map<String, List<String>> headers = asHeaders(wire.withContentType());
        byte[] body = wire.body.get().getBytes();
        assertEquals(
                "bad-signature",
                k.verifier().verify("POST", "/markets/ETH%2FUSDT/orders", headers, body).reason());
        assertEquals("bad-signature", k.verifier().verify("PUT", wire.target(), headers, body).reason());
        Map<String, String> typed = wire.withContentType();
        typed.put("content-type", "text/plain");
        assertEquals(
                "bad-signature", k.verifier().verify("POST", wire.target(), asHeaders(typed), body).reason());
        assertEquals(
                "body-mismatch",
                k.verifier().verify("POST", wire.target(), headers, "{\"qty\":\"9\"}".getBytes()).reason());
    }

    @Test
    void envBuildsTheSignerAndRefusesWhatIsMalformed() throws Exception {
        assertNull(ServiceKeys.outboundFromEnv(Map.of(), "svc-fix"));
        assertNull(ServiceKeys.outboundFromEnv(Map.of("S2S_AUTH_MODE", "off"), "svc-fix"));
        assertThrows(ServiceKeys.KeyError.class, () -> ServiceKeys.outboundFromEnv(Map.of("S2S_AUTH_MODE", "bogus"), "svc-fix"));
        assertThrows(ServiceKeys.KeyError.class, () -> ServiceKeys.outboundFromEnv(Map.of("S2S_AUTH_MODE", "dual"), "svc-fix"));
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] spki = pair.getPublic().getEncoded();
        byte[] raw = new byte[32];
        System.arraycopy(spki, spki.length - 32, raw, 0, 32);
        String ring = "{\"keys\":[{\"kid\":\"svc-fix.a\",\"svc\":\"svc-fix\",\"use\":\"s2s\",\"x\":\""
                + Base64.getUrlEncoder().withoutPadding().encodeToString(raw) + "\"}]}";
        String pkcs8 = Base64.getUrlEncoder().withoutPadding().encodeToString(pair.getPrivate().getEncoded());
        // dual or keypair without a signing key stops boot: no silent fallback to the shared secret.
        for (String mode : new String[] {"dual", "keypair"}) {
            assertThrows(
                    ServiceKeys.KeyError.class,
                    () -> ServiceKeys.outboundFromEnv(Map.of("S2S_AUTH_MODE", mode, "S2S_KEYRING", ring), "svc-fix"));
        }
        // Half a key pair stops boot.
        assertThrows(
                ServiceKeys.KeyError.class,
                () -> ServiceKeys.outboundFromEnv(
                        Map.of("S2S_AUTH_MODE", "dual", "S2S_KEYRING", ring, "S2S_SIGNING_KID", "svc-fix.a"), "svc-fix"));
        // A key that the keyring does not publish stops boot.
        KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String otherKey = Base64.getUrlEncoder().withoutPadding().encodeToString(other.getPrivate().getEncoded());
        assertThrows(
                ServiceKeys.KeyError.class,
                () -> ServiceKeys.outboundFromEnv(
                        Map.of(
                                "S2S_AUTH_MODE", "keypair", "S2S_KEYRING", ring,
                                "S2S_SIGNING_KID", "svc-fix.a", "S2S_SIGNING_KEY", otherKey),
                        "svc-fix"));
        ServiceKeys.Outbound ok = ServiceKeys.outboundFromEnv(
                Map.of(
                        "S2S_AUTH_MODE", "keypair", "S2S_KEYRING", ring,
                        "S2S_SIGNING_KID", "svc-fix.a", "S2S_SIGNING_KEY", pkcs8),
                "svc-fix");
        assertTrue(ok.keypairOnly());
    }
}
