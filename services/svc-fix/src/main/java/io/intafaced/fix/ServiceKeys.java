package io.intafaced.fix;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Per-service Ed25519 keys (S2S v3), verify side. Byte for byte the scheme in
 * {@code packages/contracts/src/service-keys.ts}: the same six headers, patterns, clock window,
 * length-prefixed preimage, context digest and replay cache. A request that carries none of the six
 * headers is {@code ABSENT}; any partial or invalid set is rejected, never ignored. A rejected
 * key-signed call is never retried against the shared secret by the caller.
 *
 * <p>The path is the raw request target: {@code getRawPath()} plus {@code ?getRawQuery()}, never a
 * decoded form. The body digest is over the raw bytes, never a re-encoded string.
 */
public final class ServiceKeys {
    public static final String KID_HEADER = "x-intafaced-s2s-kid";
    public static final String AUDIENCE_HEADER = "x-intafaced-s2s-aud";
    public static final String TIMESTAMP_HEADER = "x-intafaced-s2s-ts";
    public static final String NONCE_HEADER = "x-intafaced-s2s-nonce";
    public static final String BODY_HEADER = "x-intafaced-s2s-body";
    public static final String SIGNATURE_HEADER = "x-intafaced-s2s-sig";
    public static final String MODE_ENV = "S2S_AUTH_MODE";
    public static final String KEYRING_ENV = "S2S_KEYRING";
    public static final String SIGNING_KID_ENV = "S2S_SIGNING_KID";
    public static final String SIGNING_KEY_ENV = "S2S_SIGNING_KEY";
    public static final int PAST_SECONDS = 60;
    public static final int FUTURE_SECONDS = 5;

    private static final String[] V3_HEADERS = {
        KID_HEADER, AUDIENCE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER, BODY_HEADER, SIGNATURE_HEADER
    };
    private static final Map<String, Pattern> PATTERNS = new HashMap<>();
    private static final Pattern KID = Pattern.compile("^[a-z0-9-]{1,40}\\.[a-z0-9]{1,16}$");
    private static final Pattern PUBLIC_KEY = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final byte[] ED25519_SPKI_PREFIX = hexBytes("302a300506032b6570032100");
    private static final String DOMAIN = "intafaced-s2s-v3\n";
    private static final int NONCE_TTL_PAST_SECONDS = PAST_SECONDS + 1;
    private static final int MAX_KEYS_PER_SERVICE_AND_USE = 2;
    private static final Set<String> SERVICE_NAMES = Set.of(
            "svc-academy", "svc-agents", "svc-bank", "svc-edge", "svc-execution", "svc-fix", "svc-identity",
            "svc-ledger", "svc-market", "svc-matching", "svc-mining-pool", "svc-notify", "svc-ops", "svc-p2p",
            "svc-pay", "svc-quant", "svc-support", "svc-tax", "svc-token", "svc-trade", "svc-ws");

    static {
        PATTERNS.put(KID_HEADER, KID);
        PATTERNS.put(AUDIENCE_HEADER, Pattern.compile("^svc-[a-z0-9-]{1,40}$"));
        PATTERNS.put(TIMESTAMP_HEADER, Pattern.compile("^[1-9][0-9]{9,10}$"));
        PATTERNS.put(NONCE_HEADER, Pattern.compile("^[A-Za-z0-9_-]{22}$"));
        PATTERNS.put(BODY_HEADER, Pattern.compile("^[0-9a-f]{64}$"));
        PATTERNS.put(SIGNATURE_HEADER, Pattern.compile("^[A-Za-z0-9_-]{86}$"));
    }

    private ServiceKeys() {}

    /** Thrown for a keyring or an auth mode that must stop the process from starting. */
    public static final class KeyError extends RuntimeException {
        public KeyError(String message) {
            super(message);
        }
    }

    public record Entry(String kid, String svc, String use, String x) {}

    public enum Status {
        ABSENT,
        ACCEPTED,
        REJECTED
    }

    public record Verdict(Status status, String service, String kid, String reason) {
        static Verdict absent() {
            return new Verdict(Status.ABSENT, null, null, null);
        }

        static Verdict rejected(String reason) {
            return new Verdict(Status.REJECTED, null, null, reason);
        }

        static Verdict accepted(String service, String kid) {
            return new Verdict(Status.ACCEPTED, service, kid, null);
        }
    }

    /** What a service holds once S2S is on: the verifier and the mode ({@code dual} or {@code keypair}). */
    public record Inbound(Verifier verifier, String mode) {
        public boolean keypairOnly() {
            return "keypair".equals(mode);
        }
    }

    /**
     * Reads {@code S2S_AUTH_MODE} and {@code S2S_KEYRING}. Unset or {@code off} returns null: the shared secret is the
     * only form, exactly as before. Anything else malformed throws, so a bad value stops boot instead of silently
     * falling back.
     */
    public static Inbound inboundFromEnv(Map<String, String> env, String self) {
        String mode = env.get(MODE_ENV);
        if (mode == null || mode.equals("off")) {
            return null;
        }
        if (!mode.equals("dual") && !mode.equals("keypair")) {
            throw new KeyError("S2S_AUTH_MODE must be exactly off, dual or keypair");
        }
        String keyring = env.get(KEYRING_ENV);
        if (keyring == null || keyring.isBlank()) {
            throw new KeyError("S2S_AUTH_MODE=" + mode + " needs S2S_KEYRING");
        }
        return new Inbound(new Verifier(self, parseKeyring(keyring), Clock.systemUTC()), mode);
    }

    /** What an outgoing client holds once S2S is on: its own signer and the mode ({@code dual} or {@code keypair}). */
    public record Outbound(Signer signer, String mode) {
        public boolean keypairOnly() {
            return "keypair".equals(mode);
        }
    }

    /**
     * The signing side, as {@code s2sFromEnv} in {@code packages/contracts/src/s2s-env.ts}. Unset or {@code off}
     * returns null (the shared secret is the only form). In {@code dual} or {@code keypair} the keyring is required and
     * {@code S2S_SIGNING_KID} / {@code S2S_SIGNING_KEY} (PKCS8, base64url) are set together or not at all; with neither,
     * this process only verifies and returns null. The private key must be the one the keyring publishes for
     * {@code self} under that key id, or boot stops.
     */
    public static Outbound outboundFromEnv(Map<String, String> env, String self) {
        String mode = env.get(MODE_ENV);
        if (mode == null || mode.equals("off")) {
            return null;
        }
        if (!mode.equals("dual") && !mode.equals("keypair")) {
            throw new KeyError("S2S_AUTH_MODE must be exactly off, dual or keypair");
        }
        String keyring = env.get(KEYRING_ENV);
        if (keyring == null || keyring.isBlank()) {
            throw new KeyError("S2S_AUTH_MODE=" + mode + " needs S2S_KEYRING");
        }
        List<Entry> entries = parseKeyring(keyring);
        String kid = env.get(SIGNING_KID_ENV);
        String pkcs8 = env.get(SIGNING_KEY_ENV);
        if ((kid == null) != (pkcs8 == null)) {
            throw new KeyError("S2S_SIGNING_KID and S2S_SIGNING_KEY are set together or not at all");
        }
        if (kid == null) {
            return null;
        }
        return new Outbound(Signer.create(self, kid, pkcs8, entries, Clock.systemUTC(), new SecureRandom()), mode);
    }

    /** Signs outgoing calls with this service's own Ed25519 key. Same preimage as {@code createServiceSigner}. */
    public static final class Signer {
        private final String kid;
        private final PrivateKey key;
        private final Clock clock;
        private final SecureRandom random;

        private Signer(String kid, PrivateKey key, Clock clock, SecureRandom random) {
            this.kid = kid;
            this.key = key;
            this.clock = clock;
            this.random = random;
        }

        /** Refuses to build unless the private key is the one the keyring publishes for this service and key id. */
        public static Signer create(
                String service, String kid, String pkcs8, List<Entry> keyring, Clock clock, SecureRandom random) {
            Entry entry = null;
            for (Entry candidate : keyring) {
                if (candidate.kid().equals(kid)) {
                    entry = candidate;
                }
            }
            if (entry == null || !entry.svc().equals(service) || !entry.use().equals("s2s")) {
                throw new KeyError(service + ": no s2s key " + kid + " for this service in the keyring");
            }
            PrivateKey key;
            try {
                key = KeyFactory.getInstance("Ed25519")
                        .generatePrivate(new PKCS8EncodedKeySpec(Base64.getUrlDecoder().decode(pkcs8)));
            } catch (Exception e) {
                throw new KeyError(service + ": S2S private key is not a PKCS8 Ed25519 key, base64url");
            }
            // Java cannot derive the public half from the private one directly: a probe signature that the published
            // key accepts proves the pair.
            try {
                byte[] probe = "intafaced-s2s-probe".getBytes(StandardCharsets.UTF_8);
                Signature signer = Signature.getInstance("Ed25519");
                signer.initSign(key);
                signer.update(probe);
                byte[] sig = signer.sign();
                Signature check = Signature.getInstance("Ed25519");
                check.initVerify(publicKey(entry.x()));
                check.update(probe);
                if (!check.verify(sig)) {
                    throw new KeyError(service + ": S2S private key does not match the published key " + kid);
                }
            } catch (KeyError e) {
                throw e;
            } catch (Exception e) {
                throw new KeyError(service + ": S2S private key does not match the published key " + kid);
            }
            return new Signer(kid, key, clock, random);
        }

        /**
         * The six v3 headers for one call.
         *
         * @param rawTarget the raw request target exactly as sent: raw path plus {@code ?rawQuery}
         * @param contentType the content-type sent with the call, or null when none is sent
         */
        public Map<String, String> headers(
                String audience, String method, String rawTarget, String body, String contentType) {
            byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
            String ts = Long.toString(Math.floorDiv(clock.millis(), 1000L));
            byte[] nonceBytes = new byte[16];
            random.nextBytes(nonceBytes);
            String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes);
            String digest = sha256Hex(bytes);
            String ctx = contextDigest(null, null, null, contentType);
            byte[] message = preimage(kid, audience, method, rawTarget, ts, nonce, digest, ctx);
            String signature;
            try {
                Signature signer = Signature.getInstance("Ed25519");
                signer.initSign(key);
                signer.update(message);
                signature = Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
            } catch (Exception e) {
                throw new IllegalStateException("Ed25519 signing failed", e);
            }
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put(KID_HEADER, kid);
            headers.put(AUDIENCE_HEADER, audience);
            headers.put(TIMESTAMP_HEADER, ts);
            headers.put(NONCE_HEADER, nonce);
            headers.put(BODY_HEADER, digest);
            headers.put(SIGNATURE_HEADER, signature);
            return headers;
        }
    }

    /** Parse the public keyring. It never accepts private material. Anything unexpected throws. */
    public static List<Entry> parseKeyring(String json) {
        Object parsed;
        try {
            parsed = new MiniJson(json).parseDocument();
        } catch (IllegalArgumentException e) {
            throw new KeyError("S2S keyring is not valid JSON");
        }
        if (!(parsed instanceof Map<?, ?> top) || !(top.get("keys") instanceof List<?> keys) || top.size() != 1) {
            throw new KeyError("S2S keyring must be {\"keys\":[...]}");
        }
        List<Entry> entries = new ArrayList<>();
        Set<String> seenKids = new HashSet<>();
        Set<String> seenKeys = new HashSet<>();
        Map<String, Integer> perOwner = new HashMap<>();
        for (Object raw : keys) {
            if (!(raw instanceof Map<?, ?> entry)) {
                throw new KeyError("S2S keyring entry must be an object");
            }
            for (Object field : entry.keySet()) {
                if (!Set.of("kid", "svc", "use", "x").contains(field)) {
                    throw new KeyError(
                            "S2S keyring entry has an unexpected field; private key material never belongs in the keyring");
                }
            }
            Object svc = entry.get("svc");
            if (!(svc instanceof String s) || !SERVICE_NAMES.contains(s)) {
                throw new KeyError("S2S keyring entry names an unknown service");
            }
            Object use = entry.get("use");
            if (!"s2s".equals(use) && !"principal".equals(use)) {
                throw new KeyError("S2S keyring entry use must be s2s or principal");
            }
            Object kid = entry.get("kid");
            if (!(kid instanceof String k) || !KID.matcher(k).matches() || !k.startsWith(s + ".")) {
                throw new KeyError("S2S key id must look like <service>.<label> and name its own service");
            }
            Object x = entry.get("x");
            if (!(x instanceof String xs) || !isCanonicalKey(xs)) {
                throw new KeyError("S2S public key must be canonical base64url of exactly 32 bytes");
            }
            if (!seenKids.add(k)) {
                throw new KeyError("S2S keyring has a duplicate key id");
            }
            if (!seenKeys.add(xs)) {
                throw new KeyError("S2S keyring lists the same public key twice");
            }
            String owner = s + "/" + use;
            int count = perOwner.merge(owner, 1, Integer::sum);
            if (count > MAX_KEYS_PER_SERVICE_AND_USE) {
                throw new KeyError("S2S keyring allows at most two keys per service and use");
            }
            entries.add(new Entry(k, s, (String) use, xs));
        }
        return entries;
    }

    private static boolean isCanonicalKey(String x) {
        if (!PUBLIC_KEY.matcher(x).matches()) {
            return false;
        }
        byte[] raw = Base64.getUrlDecoder().decode(x);
        return raw.length == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(raw).equals(x);
    }

    /** Replay cache: remembers a key until its expiry. Never evicts a live entry to make room. */
    static final class NonceCache {
        private final Map<String, Long> entries = new LinkedHashMap<>();
        private final int max;

        NonceCache(int max) {
            this.max = max;
        }

        synchronized String add(String key, long expiresAtSeconds, long nowSeconds) {
            entries.values().removeIf(expiry -> expiry <= nowSeconds);
            if (entries.containsKey(key)) {
                return "replay";
            }
            if (entries.size() >= max) {
                return "full";
            }
            entries.put(key, expiresAtSeconds);
            return "ok";
        }
    }

    public static final class Verifier {
        private final String self;
        private final Map<String, Entry> keys = new HashMap<>();
        private final Map<String, PublicKey> publicKeys = new HashMap<>();
        private final NonceCache nonces = new NonceCache(100_000);
        private final Clock clock;
        private final long bootSecond;

        public Verifier(String self, List<Entry> keyring, Clock clock) {
            this.self = self;
            this.clock = clock;
            this.bootSecond = clock.millis() / 1000;
            for (Entry entry : keyring) {
                if (entry.use().equals("s2s")) {
                    keys.put(entry.kid(), entry);
                    publicKeys.put(entry.kid(), publicKey(entry.x()));
                }
            }
        }

        /**
         * @param method the request method
         * @param rawTarget the raw request target as received: raw path plus raw query
         * @param headers every header, names compared case-insensitively
         * @param rawBody the exact body bytes; null when they were not read
         */
        public Verdict verify(
                String method, String rawTarget, Map<String, ? extends List<String>> headers, byte[] rawBody) {
            boolean any = false;
            for (String name : V3_HEADERS) {
                if (values(headers, name) != null) {
                    any = true;
                }
            }
            if (!any) {
                return Verdict.absent();
            }
            Map<String, String> v = new HashMap<>();
            for (String name : V3_HEADERS) {
                List<String> list = values(headers, name);
                if (list == null || list.size() != 1 || list.get(0) == null
                        || !PATTERNS.get(name).matcher(list.get(0)).matches()) {
                    return Verdict.rejected("malformed");
                }
                v.put(name, list.get(0));
            }
            if (!v.get(AUDIENCE_HEADER).equals(self)) {
                return Verdict.rejected("wrong-audience");
            }
            Entry known = keys.get(v.get(KID_HEADER));
            if (known == null) {
                return Verdict.rejected("unknown-key");
            }
            long nowSeconds = Math.floorDiv(clock.millis(), 1000L);
            long ts = Long.parseLong(v.get(TIMESTAMP_HEADER));
            if (ts < nowSeconds - PAST_SECONDS || ts > nowSeconds + FUTURE_SECONDS || ts < bootSecond) {
                return Verdict.rejected("stale");
            }
            String ctx = contextDigest(
                    first(headers, "x-intafaced-principal"),
                    first(headers, "x-intafaced-principal-sig"),
                    first(headers, "x-intafaced-region"),
                    first(headers, "content-type"));
            byte[] message = preimage(
                    v.get(KID_HEADER), v.get(AUDIENCE_HEADER), method, rawTarget, v.get(TIMESTAMP_HEADER),
                    v.get(NONCE_HEADER), v.get(BODY_HEADER), ctx);
            boolean ok;
            try {
                Signature verifier = Signature.getInstance("Ed25519");
                verifier.initVerify(publicKeys.get(v.get(KID_HEADER)));
                verifier.update(message);
                ok = verifier.verify(Base64.getUrlDecoder().decode(v.get(SIGNATURE_HEADER)));
            } catch (Exception e) {
                ok = false;
            }
            if (!ok) {
                return Verdict.rejected("bad-signature");
            }
            if (rawBody == null) {
                return Verdict.rejected("body-unavailable");
            }
            if (!MessageDigest.isEqual(
                    sha256Hex(rawBody).getBytes(StandardCharsets.US_ASCII),
                    v.get(BODY_HEADER).getBytes(StandardCharsets.US_ASCII))) {
                return Verdict.rejected("body-mismatch");
            }
            String outcome = nonces.add(
                    v.get(KID_HEADER) + "|" + v.get(NONCE_HEADER), ts + NONCE_TTL_PAST_SECONDS, nowSeconds);
            if (outcome.equals("replay")) {
                return Verdict.rejected("replay");
            }
            if (outcome.equals("full")) {
                return Verdict.rejected("replay-cache-full");
            }
            return Verdict.accepted(known.svc(), v.get(KID_HEADER));
        }
    }

    private static PublicKey publicKey(String x) {
        try {
            byte[] raw = Base64.getUrlDecoder().decode(x);
            byte[] der = new byte[ED25519_SPKI_PREFIX.length + raw.length];
            System.arraycopy(ED25519_SPKI_PREFIX, 0, der, 0, ED25519_SPKI_PREFIX.length);
            System.arraycopy(raw, 0, der, ED25519_SPKI_PREFIX.length, raw.length);
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception e) {
            throw new KeyError("S2S public key is not a valid Ed25519 key");
        }
    }

    static String contextDigest(String principal, String principalSignature, String region, String contentType) {
        String text = ServiceAuth.lengthPrefixed(nz(principal))
                + ServiceAuth.lengthPrefixed(nz(principalSignature))
                + ServiceAuth.lengthPrefixed(nz(region))
                + ServiceAuth.lengthPrefixed(nz(contentType));
        return ServiceAuth.sha256Hex(text);
    }

    static byte[] preimage(
            String kid, String aud, String method, String target, String ts, String nonce, String body, String ctx) {
        StringBuilder sb = new StringBuilder(DOMAIN);
        for (String field : new String[] {kid, aud, method.toUpperCase(Locale.ROOT), target, ts, nonce, body, ctx}) {
            sb.append(ServiceAuth.lengthPrefixed(field));
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder sb = new StringBuilder(64);
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String nz(String value) {
        return value == null ? "" : value;
    }

    private static List<String> values(Map<String, ? extends List<String>> headers, String name) {
        if (headers == null) {
            return null;
        }
        List<String> direct = headers.get(name);
        if (direct != null) {
            return direct;
        }
        for (Map.Entry<String, ? extends List<String>> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().toLowerCase(Locale.ROOT).equals(name)) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static String first(Map<String, ? extends List<String>> headers, String name) {
        List<String> list = values(headers, name);
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    private static byte[] hexBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /** A strict JSON reader for the keyring: objects, arrays and strings only. Anything else is invalid. */
    static final class MiniJson {
        private final String text;
        private final boolean integers;
        private int pos;

        MiniJson(String text) {
            this(text, false);
        }

        /** {@code integers}: also read plain non-negative integers (test fixtures). The keyring never needs them. */
        MiniJson(String text, boolean integers) {
            this.text = text;
            this.integers = integers;
        }

        Object parseDocument() {
            skip();
            Object value = value();
            skip();
            if (pos != text.length()) {
                throw new IllegalArgumentException("trailing text");
            }
            return value;
        }

        private Object value() {
            if (pos >= text.length()) {
                throw new IllegalArgumentException("end");
            }
            char c = text.charAt(pos);
            if (c == '{') {
                return object();
            }
            if (c == '[') {
                return array();
            }
            if (c == '"') {
                return string();
            }
            if (integers && c >= '0' && c <= '9') {
                int start = pos;
                while (pos < text.length() && text.charAt(pos) >= '0' && text.charAt(pos) <= '9') {
                    pos++;
                }
                return Long.parseLong(text.substring(start, pos));
            }
            throw new IllegalArgumentException("unexpected " + c);
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++;
            skip();
            if (peek() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skip();
                String key = string();
                skip();
                expect(':');
                skip();
                if (map.put(key, value()) != null) {
                    throw new IllegalArgumentException("duplicate key");
                }
                skip();
                char c = next();
                if (c == '}') {
                    return map;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected , or }");
                }
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            pos++;
            skip();
            if (peek() == ']') {
                pos++;
                return list;
            }
            while (true) {
                skip();
                list.add(value());
                skip();
                char c = next();
                if (c == ']') {
                    return list;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected , or ]");
                }
            }
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') {
                    return sb.toString();
                }
                if (c < 0x20) {
                    throw new IllegalArgumentException("control character");
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = next();
                switch (e) {
                    case '"', '\\', '/' -> sb.append(e);
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        if (pos + 4 > text.length()) {
                            throw new IllegalArgumentException("short escape");
                        }
                        sb.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                        pos += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape");
                }
            }
        }

        private void skip() {
            while (pos < text.length() && " \t\r\n".indexOf(text.charAt(pos)) >= 0) {
                pos++;
            }
        }

        private char peek() {
            if (pos >= text.length()) {
                throw new IllegalArgumentException("end");
            }
            return text.charAt(pos);
        }

        private char next() {
            char c = peek();
            pos++;
            return c;
        }

        private void expect(char c) {
            if (next() != c) {
                throw new IllegalArgumentException("expected " + c);
            }
        }
    }
}
