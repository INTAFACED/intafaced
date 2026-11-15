package io.intafaced.fix;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import quickfix.Session;
import quickfix.SessionID;

/**
 * The adapter's own status (J-cex-spot-20 #3, SP-order-02): each FIX session as QuickFIX/J holds it right now, and the
 * CompID to account map svc-fix submits orders with. A read only. svc-fix holds no balance, margin or Greeks, so none
 * is here: it is an adapter onto matching, not a book and not a ledger.
 *
 * {@code GET /internal/status} answers the founder console's door on svc-edge alone. It is signed as {@code svc-edge}
 * with the dedicated read key {@code FIX_STATUS_READ_SECRET} (never INTERNAL_SERVICE_SECRET: the edge holds no fleet
 * secret), or with an S2S v3 key of svc-edge when S2S is on. A blank key refuses {@code fix_status_unconfigured}; the
 * acceptor still runs. {@code GET /health} says only that the process answers.
 */
public final class AdapterStatus {
    public static final String PATH = "/internal/status";
    public static final String HEALTH_PATH = "/health";
    public static final String SECRET_ENV = "FIX_STATUS_READ_SECRET";
    public static final String UNCONFIGURED = "fix_status_unconfigured";
    /** The only caller that may read the status. */
    static final String CALLER = "svc-edge";

    public static final String ORDER_ENTRY = "order-entry";
    public static final String DROP_COPY = "drop-copy";
    public static final String LOGGED_ON = "Logged on";
    public static final String NOT_LOGGED_ON = "Not logged on";

    private AdapterStatus() {}

    /** One FIX session the acceptor holds, read from QuickFIX/J. */
    public record SessionRow(
            String role,
            String beginString,
            String senderCompId,
            String targetCompId,
            String state,
            String accountId,
            Integer nextSenderSeq,
            Integer nextTargetSeq) {}

    /**
     * The rows for one acceptor's sessions. The counterparty's CompID is the session's TargetCompID (it arrives as
     * SenderCompID on its orders), so that is the key into the account map. A drop-copy session carries no orders and
     * maps to no account.
     */
    public static List<SessionRow> rows(String role, List<SessionID> ids, Map<String, String> compIdAccounts) {
        List<SessionRow> out = new ArrayList<>();
        if (ids == null) {
            return out;
        }
        for (SessionID id : ids) {
            Session session = Session.lookupSession(id);
            boolean on = session != null && session.isLoggedOn();
            String account = ORDER_ENTRY.equals(role) && compIdAccounts != null
                    ? compIdAccounts.get(id.getTargetCompID())
                    : null;
            out.add(new SessionRow(
                    role,
                    id.getBeginString(),
                    id.getSenderCompID(),
                    id.getTargetCompID(),
                    on ? LOGGED_ON : NOT_LOGGED_ON,
                    account,
                    sequence(session == null ? -1 : session.getExpectedSenderNum()),
                    sequence(session == null ? -1 : session.getExpectedTargetNum())));
        }
        return out;
    }

    /** QuickFIX/J answers -1 when its store could not be read: that sequence is unread (null), never a number. */
    private static Integer sequence(int raw) {
        return raw < 0 ? null : raw;
    }

    /** The status body. {@code compIdAccounts} null = FIX_COMPID_ACCOUNT_JSON is blank (every order then refuses). */
    public static String json(List<SessionRow> sessions, Map<String, String> compIdAccounts, Instant now) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\"service\":\"svc-fix\",\"sessions\":[");
        for (int i = 0; i < sessions.size(); i++) {
            SessionRow s = sessions.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"role\":").append(Json.string(s.role()));
            sb.append(",\"beginString\":").append(Json.string(s.beginString()));
            sb.append(",\"senderCompId\":").append(Json.string(s.senderCompId()));
            sb.append(",\"targetCompId\":").append(Json.string(s.targetCompId()));
            sb.append(",\"state\":").append(Json.string(s.state()));
            sb.append(",\"accountId\":").append(s.accountId() == null ? "null" : Json.string(s.accountId()));
            sb.append(",\"nextSenderSeq\":").append(s.nextSenderSeq() == null ? "null" : s.nextSenderSeq().toString());
            sb.append(",\"nextTargetSeq\":").append(s.nextTargetSeq() == null ? "null" : s.nextTargetSeq().toString());
            sb.append('}');
        }
        sb.append("],\"compIdMapSet\":").append(compIdAccounts != null);
        sb.append(",\"compIdMap\":[");
        if (compIdAccounts != null) {
            int i = 0;
            for (Map.Entry<String, String> e : compIdAccounts.entrySet()) {
                if (i++ > 0) {
                    sb.append(',');
                }
                sb.append("{\"compId\":").append(Json.string(e.getKey()));
                sb.append(",\"accountId\":").append(Json.string(e.getValue())).append('}');
            }
        }
        sb.append("],\"asOf\":").append(Json.string((now == null ? Instant.now() : now).toString()));
        sb.append('}');
        return sb.toString();
    }

    /** {@code GET /health}: the process answers. Nothing else. */
    public static HttpHandler health() {
        return exchange -> {
            try {
                if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                    write(exchange, 405, refuseJson("method_not_allowed", "health is GET " + HEALTH_PATH));
                    return;
                }
                write(exchange, 200, "{\"ok\":true,\"service\":\"svc-fix\"}");
            } finally {
                exchange.close();
            }
        };
    }

    /** {@code GET /internal/status}, signed by svc-edge. {@code body} is built on each read. */
    public static HttpHandler handler(Supplier<String> body, String secret, ServiceKeys.Inbound s2s) {
        return exchange -> {
            try {
                handle(exchange, body, secret, s2s);
            } finally {
                exchange.close();
            }
        };
    }

    private static void handle(HttpExchange exchange, Supplier<String> body, String secret, ServiceKeys.Inbound s2s)
            throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            write(exchange, 405, refuseJson("method_not_allowed", "the adapter status is GET " + PATH));
            return;
        }
        byte[] raw = exchange.getRequestBody().readAllBytes();
        Headers headers = exchange.getRequestHeaders();
        String caller = null;
        if (s2s != null) {
            java.net.URI uri = exchange.getRequestURI();
            String target = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
            ServiceKeys.Verdict keyed = s2s.verifier().verify(exchange.getRequestMethod(), target, headers, raw);
            if (keyed.status() == ServiceKeys.Status.REJECTED) {
                write(exchange, 401, refuseJson("unauthenticated", "the service key was refused"));
                return;
            }
            if (keyed.status() == ServiceKeys.Status.ACCEPTED) {
                caller = keyed.service();
            } else if (s2s.keypairOnly()) {
                write(exchange, 401, refuseJson("unauthenticated", "service key required"));
                return;
            }
        }
        if (caller == null) {
            if (!ServiceAuth.secretReady(secret)) {
                write(
                        exchange,
                        503,
                        refuseJson(
                                UNCONFIGURED,
                                SECRET_ENV + " is blank; svc-fix does not show its sessions to an unsigned caller"));
                return;
            }
            ServiceAuth.VerifyResult auth = ServiceAuth.verifyServiceHeaders(
                    headers, secret, new String(raw, StandardCharsets.UTF_8), Instant.now());
            if (!auth.ok()) {
                write(exchange, 401, refuseJson("unauthenticated", "service credentials required (" + auth.rejected + ")"));
                return;
            }
            caller = auth.service;
        }
        if (!CALLER.equals(caller)) {
            write(exchange, 403, refuseJson("forbidden", "the adapter status is read by svc-edge only"));
            return;
        }
        write(exchange, 200, body.get());
    }

    static String refuseJson(String code, String message) {
        return "{\"ok\":false,\"error\":{\"code\":" + Json.string(code) + ",\"message\":" + Json.string(message) + "}}";
    }

    private static void write(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
