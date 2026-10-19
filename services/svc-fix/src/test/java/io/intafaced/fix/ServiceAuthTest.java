package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class ServiceAuthTest {
    private static final String SECRET = "a".repeat(32);
    private static final String BODY =
            "{\"orderId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"accountId\":\"acct-desk\",\"type\":\"limit\",\"side\":\"buy\",\"qty\":\"1.50\",\"price\":\"100.25\",\"tif\":\"GTC\"}";
    private static final long TS = 1_700_000_000L;
    private static final String DIGEST = "84f68d80115cc3b36a434538903a6e9dec0ebd4eeecdd4385d835700b2df6033";
    private static final String SIG = "2831db1a110350f0122e18ff3e8ac028eb7e158d6fa058b7cf454466d89955f8";

    @Test
    void v2HeadersMatchContractsServiceAuthHeadersForBody() {
        Map<String, String> headers = ServiceAuth.headersForBody(SECRET, BODY, TS);
        assertEquals("svc-fix", headers.get(ServiceAuth.SERVICE_HEADER));
        assertEquals(Long.toString(TS), headers.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER));
        assertEquals(DIGEST, headers.get(ServiceAuth.SERVICE_BODY_DIGEST_HEADER));
        assertEquals(SIG, headers.get(ServiceAuth.SERVICE_SIGNATURE_HEADER));
    }

    @Test
    void blankSecretIsNotReady() {
        assertFalse(ServiceAuth.secretReady(null));
        assertFalse(ServiceAuth.secretReady(""));
        assertFalse(ServiceAuth.secretReady("short"));
        assertTrue(ServiceAuth.secretReady(SECRET));
    }

    @Test
    void requireBodyBindAcceptsV2AndRefusesV1AndMismatch() {
        java.time.Instant now = java.time.Instant.ofEpochSecond(TS);
        Map<String, String> v2 = ServiceAuth.headersForBody(SECRET, BODY, TS);
        ServiceAuth.VerifyResult ok = ServiceAuth.verifyServiceCall(
                v2.get(ServiceAuth.SERVICE_HEADER),
                v2.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER),
                v2.get(ServiceAuth.SERVICE_SIGNATURE_HEADER),
                v2.get(ServiceAuth.SERVICE_BODY_DIGEST_HEADER),
                SECRET,
                BODY,
                now);
        assertTrue(ok.ok());
        assertEquals("svc-fix", ok.service);
        assertEquals("v2", ok.scheme);

        String wrongSig = "2831db1a110350f0122e18ff3e8ac028eb7e158d6fa058b7cf454466d89955f0";
        ServiceAuth.VerifyResult badSig = ServiceAuth.verifyServiceCall(
                v2.get(ServiceAuth.SERVICE_HEADER),
                v2.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER),
                wrongSig,
                v2.get(ServiceAuth.SERVICE_BODY_DIGEST_HEADER),
                SECRET,
                BODY,
                now);
        assertFalse(badSig.ok());
        assertEquals("bad-signature", badSig.rejected);

        ServiceAuth.VerifyResult v1 = ServiceAuth.verifyServiceCall(
                "svc-fix", Long.toString(TS), ServiceAuth.hmacSha256Hex(SECRET, "svc-fix\n" + TS), null, SECRET, BODY, now);
        assertFalse(v1.ok());
        assertEquals("missing-body-digest", v1.rejected);

        ServiceAuth.VerifyResult mismatch = ServiceAuth.verifyServiceCall(
                v2.get(ServiceAuth.SERVICE_HEADER),
                v2.get(ServiceAuth.SERVICE_TIMESTAMP_HEADER),
                v2.get(ServiceAuth.SERVICE_SIGNATURE_HEADER),
                v2.get(ServiceAuth.SERVICE_BODY_DIGEST_HEADER),
                SECRET,
                BODY + " ",
                now);
        assertFalse(mismatch.ok());
        assertEquals("body-mismatch", mismatch.rejected);

        ServiceAuth.VerifyResult blank = ServiceAuth.verifyServiceCall(
                "svc-fix", Long.toString(TS), "ab", DIGEST, "", BODY, now);
        assertFalse(blank.ok());
        assertEquals("missing", blank.rejected);
        assertEquals("require", ServiceAuth.BODY_BIND_REQUIRE);
    }
}
