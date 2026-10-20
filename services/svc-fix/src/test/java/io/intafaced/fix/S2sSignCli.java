package io.intafaced.fix;

import java.util.Map;

/**
 * Test-only entry point for the cross-language check in src/matching-port-java-keys.test.ts: runs the real
 * {@link MatchingSubmitPort#submit} with S2S_* read from the environment (as the live process reads them) and prints
 * what went on the wire as one JSON object: url, body, headers. The TypeScript contracts verifier then judges it.
 * Not a JUnit test and never shipped.
 */
public final class S2sSignCli {
    private S2sSignCli() {}

    public static void main(String[] args) {
        Map<String, String> env = System.getenv();
        StringBuilder out = new StringBuilder();
        MatchingSubmitPort port = new MatchingSubmitPort(
                env.get(MatchingSubmitPort.BASE_URL_ENV),
                env.get(MatchingSubmitPort.COMPID_ACCOUNT_JSON_ENV),
                env.get(MatchingSubmitPort.SERVICE_SECRET_ENV),
                ServiceKeys.outboundFromEnv(env, ServiceAuth.SERVICE_NAME),
                (url, json, headers) -> {
                    out.append("{\"url\":").append(Json.string(url)).append(",\"body\":").append(Json.string(json));
                    out.append(",\"headers\":{");
                    boolean first = true;
                    for (Map.Entry<String, String> header : headers.entrySet()) {
                        if (!first) {
                            out.append(',');
                        }
                        first = false;
                        out.append(Json.string(header.getKey())).append(':').append(Json.string(header.getValue()));
                    }
                    out.append("}}");
                    return new MatchingSubmitPort.Transport.Response(200, "{\"accepted\":true,\"sequence\":1}");
                });
        MatchingOrderCommand command = new MatchingOrderCommand(
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
        MatchingSubmitResult result = port.submit(command);
        if (!result.ok) {
            System.err.print(result.errorCode + ": " + result.errorMessage);
            System.exit(3);
        }
        System.out.print(out);
    }
}
