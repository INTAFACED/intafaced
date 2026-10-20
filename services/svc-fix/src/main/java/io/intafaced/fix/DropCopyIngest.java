package io.intafaced.fix;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import quickfix.Message;

/**
 * HMAC-required HTTP ingest for house-book fills onto the FIX drop-copy hub.
 * Body-bind require is hardcoded. Blank secret refuses. No ledger.
 */
public final class DropCopyIngest implements AutoCloseable {
    public static final String PATH = "/internal/drop-copy/fills";

    private final HttpServer server;
    private final int port;

    private DropCopyIngest(HttpServer server, int port) {
        this.server = server;
        this.port = port;
    }

    public int port() {
        return port;
    }

    public static Result start(int port, String beginString, String secret, DropCopyHub hub) {
        return start(port, beginString, secret, hub, null);
    }

    /**
     * With {@code s2s} set (per-service keys, S2S v3) a key-signed fill is accepted from svc-trade only, and a failed
     * key-signed call is refused without trying the shared secret. {@code keypair} mode needs no shared secret.
     */
    public static Result start(
            int port, String beginString, String secret, DropCopyHub hub, ServiceKeys.Inbound s2s) {
        if (port <= 0) {
            return Result.refuse(
                    DropCopyIngestConfig.UNCONFIGURED,
                    DropCopyIngestConfig.PORT_ENV + " is blank; svc-fix does not invent a listen port");
        }
        if (!ServiceAuth.secretReady(secret) && (s2s == null || !s2s.keypairOnly())) {
            return Result.refuse(
                    "service_auth_unconfigured",
                    "INTERNAL_SERVICE_SECRET is blank; svc-fix does not accept unsigned drop-copy fills");
        }
        DropCopyHub target = hub == null ? DropCopyHub.disabled() : hub;
        try {
            HttpServer http = HttpServer.create(new InetSocketAddress(port), 0);
            int bound = http.getAddress().getPort();
            http.createContext(PATH, exchange -> handle(exchange, beginString, secret, target, s2s));
            http.setExecutor(Executors.newCachedThreadPool(daemonFactory()));
            http.start();
            return Result.ok(new DropCopyIngest(http, bound));
        } catch (IOException e) {
            String detail = e.getMessage() == null ? "unknown" : e.getMessage();
            return Result.refuse("dropcopy_ingest_unavailable", "drop-copy ingest failed to bind: " + detail);
        }
    }

    public static final class Result {
        public final boolean ok;
        public final DropCopyIngest ingest;
        public final String errorCode;
        public final String errorMessage;

        private Result(boolean ok, DropCopyIngest ingest, String errorCode, String errorMessage) {
            this.ok = ok;
            this.ingest = ingest;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static Result ok(DropCopyIngest ingest) {
            return new Result(true, ingest, null, null);
        }

        static Result refuse(String code, String message) {
            return new Result(false, null, code, message);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }

    /** The only service that may deliver drop-copy fills by key. */
    static final String KEYED_CALLER = "svc-trade";

    private static void handle(
            HttpExchange exchange, String beginString, String secret, DropCopyHub hub, ServiceKeys.Inbound s2s)
            throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                write(exchange, 405, refuseJson("unsupported_msg_type", "drop-copy ingest is POST " + PATH));
                return;
            }
            byte[] bytes = exchange.getRequestBody().readAllBytes();
            String body = new String(bytes, StandardCharsets.UTF_8);
            Headers headers = exchange.getRequestHeaders();
            ServiceKeys.Verdict keyed = s2s == null ? null : verifyKeyed(exchange, headers, bytes, s2s);
            if (keyed != null && keyed.status() == ServiceKeys.Status.REJECTED) {
                write(
                        exchange,
                        401,
                        refuseJson("unauthenticated", "service credentials required; the service key was refused"));
                return;
            }
            if (keyed != null && keyed.status() == ServiceKeys.Status.ACCEPTED) {
                if (!KEYED_CALLER.equals(keyed.service())) {
                    write(exchange, 403, refuseJson("forbidden", "drop-copy fills are accepted from svc-trade only"));
                    return;
                }
            } else if (s2s != null && s2s.keypairOnly()) {
                write(exchange, 401, refuseJson("unauthenticated", "service key required"));
                return;
            } else if (!ServiceAuth.secretReady(secret)) {
                write(
                        exchange,
                        401,
                        refuseJson(
                                "service_auth_unconfigured",
                                "INTERNAL_SERVICE_SECRET is blank; svc-fix does not accept unsigned drop-copy fills"));
                return;
            }
            if (keyed == null || keyed.status() != ServiceKeys.Status.ACCEPTED) {
                ServiceAuth.VerifyResult auth =
                        ServiceAuth.verifyServiceHeaders(headers, secret, body, Instant.now());
                if (!auth.ok()) {
                    write(
                            exchange,
                            401,
                            refuseJson(
                                    "unauthenticated",
                                    "service credentials required; HMAC body-bind "
                                            + ServiceAuth.BODY_BIND_REQUIRE
                                            + " on the raw fill body"));
                    return;
                }
            }
            DropCopyFill.ParseResult parsed = DropCopyFill.parse(body);
            if (!parsed.ok) {
                write(exchange, 400, refuseJson(parsed.errorCode, parsed.errorMessage));
                return;
            }
            Message er = ExecutionReportFactory.fromFill(beginString, parsed.fill);
            if (er == null) {
                write(
                        exchange,
                        400,
                        refuseJson(
                                "dropcopy_execution_missing",
                                "execution is missing; svc-fix does not synthesize a drop-copy fill"));
                return;
            }
            DropCopyPublishResult published = hub.publish(parsed.fill.source, er);
            if (!published.ok) {
                write(exchange, 400, refuseJson(published.errorCode, published.errorMessage));
                return;
            }
            StringBuilder sb = new StringBuilder(128);
            sb.append("{\"ok\":true,\"delivered\":").append(published.delivered);
            sb.append(",\"included\":");
            appendStrings(sb, hub.included());
            sb.append('}');
            write(exchange, 200, sb.toString());
        } finally {
            exchange.close();
        }
    }

    private static String refuseJson(String code, String message) {
        return "{\"ok\":false,\"error\":{\"code\":"
                + Json.string(code)
                + ",\"message\":"
                + Json.string(message)
                + "}}";
    }

    private static void appendStrings(StringBuilder sb, List<String> values) {
        sb.append('[');
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(Json.string(values.get(i)));
        }
        sb.append(']');
    }

    private static ServiceKeys.Verdict verifyKeyed(
            HttpExchange exchange, Headers headers, byte[] bytes, ServiceKeys.Inbound s2s) {
        java.net.URI uri = exchange.getRequestURI();
        String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        return s2s.verifier().verify(exchange.getRequestMethod(), target, headers, bytes);
    }

    private static void write(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static ThreadFactory daemonFactory() {
        AtomicInteger n = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable, "dropcopy-ingest-" + n.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
