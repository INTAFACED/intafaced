package io.intafaced.fix;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import quickfix.ConfigError;
import quickfix.FixVersions;
import quickfix.SessionSettings;

/**
 * OWNER-SET QFJ acceptor sockets. Blank port/CompID/HeartBtInt refuse.
 * Never invent a listen port, CompID, heartbeat, or rulebook version.
 */
public final class FixAcceptorConfig {
    public static final String BEGIN_STRING_ENV = "FIX_BEGIN_STRING";
    public static final String SENDER_COMP_ID_ENV = "FIX_SENDER_COMP_ID";
    public static final String TARGET_COMP_ID_ENV = "FIX_TARGET_COMP_ID";
    public static final String SOCKET_ACCEPT_PORT_ENV = "FIX_SOCKET_ACCEPT_PORT";
    public static final String HEARTBTINT_ENV = "FIX_HEARTBTINT";
    public static final String RULEBOOK_VERSION_ENV = "MATCHING_RULEBOOK_VERSION";
    public static final String STORE_PATH_ENV = "FIX_STORE_PATH";
    public static final String STORE_UNCONFIGURED = "order_entry_store_unconfigured";

    public final String productBegin;
    public final String senderCompId;
    public final String targetCompId;
    public final int socketAcceptPort;
    public final int heartBtInt;
    public final String rulebookVersion;

    FixAcceptorConfig(
            String productBegin,
            String senderCompId,
            String targetCompId,
            int socketAcceptPort,
            int heartBtInt,
            String rulebookVersion) {
        this.productBegin = productBegin;
        this.senderCompId = senderCompId;
        this.targetCompId = targetCompId;
        this.socketAcceptPort = socketAcceptPort;
        this.heartBtInt = heartBtInt;
        this.rulebookVersion = rulebookVersion;
    }

    public static SessionConfigResult fromOwner(
            String productBegin,
            String senderCompId,
            String targetCompId,
            String portRaw,
            String heartRaw,
            String rulebookVersion) {
        String begin = trim(productBegin);
        if (begin.isEmpty()) {
            return SessionConfigResult.refuse(
                    "unsupported_begin_string",
                    "FIX_BEGIN_STRING is blank; svc-fix does not invent FIX.4.4");
        }
        if (!FixDictionaries.isSupportedBeginString(begin) && !FixVersions.FIX50.equals(begin)) {
            return SessionConfigResult.refuse(
                    "unsupported_begin_string",
                    "BeginString " + begin + " is not FIX.4.2, FIX.4.4, FIX.5.0, or FIXT.1.1");
        }
        String sender = trim(senderCompId);
        if (sender.isEmpty()) {
            return SessionConfigResult.refuse(
                    "session_unconfigured", "FIX_SENDER_COMP_ID is blank; svc-fix does not invent a CompID");
        }
        String target = trim(targetCompId);
        if (target.isEmpty()) {
            return SessionConfigResult.refuse(
                    "session_unconfigured", "FIX_TARGET_COMP_ID is blank; svc-fix does not invent a CompID");
        }
        Integer port = parsePositiveInt(portRaw);
        if (port == null) {
            return SessionConfigResult.refuse(
                    "session_unconfigured",
                    "FIX_SOCKET_ACCEPT_PORT is blank; svc-fix does not invent a listen port");
        }
        Integer heart = parsePositiveInt(heartRaw);
        if (heart == null) {
            return SessionConfigResult.refuse(
                    "session_unconfigured", "FIX_HEARTBTINT is blank; svc-fix does not invent a heartbeat");
        }
        return SessionConfigResult.accept(
                new FixAcceptorConfig(begin, sender, target, port, heart, trim(rulebookVersion)));
    }

    public static SessionConfigResult fromOwnerEnv(Map<String, String> env) {
        return fromOwner(
                env.get(BEGIN_STRING_ENV),
                env.get(SENDER_COMP_ID_ENV),
                env.get(TARGET_COMP_ID_ENV),
                env.get(SOCKET_ACCEPT_PORT_ENV),
                env.get(HEARTBTINT_ENV),
                env.get(RULEBOOK_VERSION_ENV));
    }

    /** Certification is OPS. Refuse the claim when rulebook version is blank. */
    public static SessionConfigResult refuseCertifiedClaim(String rulebookVersion) {
        if (trim(rulebookVersion).isEmpty()) {
            return SessionConfigResult.refuse(
                    "certified_unconfigured",
                    "certified requires MATCHING_RULEBOOK_VERSION; svc-fix does not invent a rulebook");
        }
        return SessionConfigResult.refuse(
                "certified_unconfigured",
                "certification program is OPS; svc-fix does not mint a certified claim");
    }

    /** Blank store: memory session, sequences reset. Does not invent a path. */
    public SessionSettings toSessionSettings() throws ConfigError {
        return toSessionSettings("");
    }

    /**
     * Order-entry session. Blank store path keeps memory and the three resets.
     * Owner directory → FileStorePath, PersistMessages=Y, and no reset, so a
     * replayed NewOrderSingle is not a new message. Does not invent a path.
     */
    public SessionSettings toSessionSettings(String storePath) throws ConfigError {
        return sessionSettings(storePath);
    }

    /**
     * Drop-copy session. Blank store path keeps memory and the three resets.
     * Owner directory → FileStorePath and no reset, so ResendRequest can replay.
     * Does not invent a path. Order-entry uses {@link #toSessionSettings(String)}
     * with its own path.
     */
    public SessionSettings toDropCopySessionSettings(String storePath) throws ConfigError {
        return sessionSettings(storePath);
    }

    /**
     * Blank store path is valid: memory session, sequences reset.
     * A set path must already be a directory — svc-fix does not mkdir a store.
     */
    public static StoreResult storeFromEnv(Map<String, String> env) {
        String path = storePath(env);
        if (path.isEmpty()) {
            return StoreResult.memory();
        }
        Path dir = Path.of(path);
        if (!Files.isDirectory(dir)) {
            return StoreResult.refuse(
                    STORE_UNCONFIGURED,
                    "FIX_STORE_PATH is not a directory; svc-fix does not invent an order-entry store");
        }
        return StoreResult.durable(dir.toAbsolutePath().toString());
    }

    public static String storePath(Map<String, String> env) {
        if (env == null) {
            return "";
        }
        String raw = env.get(STORE_PATH_ENV);
        return raw == null ? "" : raw.trim();
    }

    public static final class StoreResult {
        public final boolean ok;
        public final boolean durable;
        public final String path;
        public final String errorCode;
        public final String errorMessage;

        private StoreResult(boolean ok, boolean durable, String path, String errorCode, String errorMessage) {
            this.ok = ok;
            this.durable = durable;
            this.path = path;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static StoreResult memory() {
            return new StoreResult(true, false, "", null, null);
        }

        static StoreResult durable(String path) {
            return new StoreResult(true, true, path, null, null);
        }

        static StoreResult refuse(String errorCode, String errorMessage) {
            return new StoreResult(false, false, "", errorCode, errorMessage);
        }
    }

    private SessionSettings sessionSettings(String storePath) throws ConfigError {
        String sessionBegin = FixDictionaries.sessionBeginString(productBegin);
        String appDd = FixDictionaries.applicationResource(productBegin);
        String transportDd = FixDictionaries.transportResource(productBegin);
        String path = trim(storePath);
        StringBuilder text = new StringBuilder();
        text.append("[DEFAULT]\n");
        text.append("ConnectionType=acceptor\n");
        text.append("HeartBtInt=").append(heartBtInt).append('\n');
        text.append("StartTime=00:00:00\n");
        text.append("EndTime=00:00:00\n");
        text.append("UseDataDictionary=Y\n");
        text.append("TimeZone=UTC\n");
        if (path.isEmpty()) {
            text.append("ResetOnLogon=Y\n");
            text.append("ResetOnLogout=Y\n");
            text.append("ResetOnDisconnect=Y\n");
        } else {
            text.append("FileStorePath=").append(path).append('\n');
            text.append("PersistMessages=Y\n");
            text.append("ResetOnLogon=N\n");
            text.append("ResetOnLogout=N\n");
            text.append("ResetOnDisconnect=N\n");
        }
        text.append("[SESSION]\n");
        text.append("BeginString=").append(sessionBegin).append('\n');
        text.append("SenderCompID=").append(senderCompId).append('\n');
        text.append("TargetCompID=").append(targetCompId).append('\n');
        text.append("SocketAcceptPort=").append(socketAcceptPort).append('\n');
        if (FixVersions.BEGINSTRING_FIXT11.equals(sessionBegin)) {
            text.append("DefaultApplVerID=7\n");
            text.append("TransportDataDictionary=").append(transportDd).append('\n');
            text.append("AppDataDictionary=").append(appDd).append('\n');
        } else {
            text.append("DataDictionary=").append(appDd).append('\n');
        }
        return new SessionSettings(new java.io.ByteArrayInputStream(text.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static String trim(String raw) {
        return raw == null ? "" : raw.trim();
    }

    private static Integer parsePositiveInt(String raw) {
        String text = trim(raw);
        if (text.isEmpty()) {
            return null;
        }
        try {
            int value = Integer.parseInt(text);
            if (value <= 0) {
                return null;
            }
            return value;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
