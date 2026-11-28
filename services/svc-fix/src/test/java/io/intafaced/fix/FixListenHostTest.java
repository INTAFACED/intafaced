package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.SocketAddress;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Every svc-fix listener binds the fleet's HTTP_HOST (#10244): with 127.0.0.1 set, the order-entry and drop-copy FIX
 * sockets and the ingest listener are reachable only from this machine. Blank keeps every interface (the container).
 */
class FixListenHostTest {

    @Test
    @Timeout(60)
    void everyListenerBindsTheHostItIsGiven() throws Exception {
        Map<String, String> env = env();
        env.put(FixAcceptorMain.LISTEN_HOST_ENV, "127.0.0.1");
        List<SocketAddress> bound = listening(env);
        assertEquals(3, bound.size(), "two FIX sockets and the ingest listener: " + bound);
        for (SocketAddress a : bound) {
            assertTrue(((InetSocketAddress) a).getAddress().isLoopbackAddress(), "bound off loopback: " + a);
        }
    }

    @Test
    @Timeout(60)
    void aBlankHostListensOnEveryInterface() throws Exception {
        List<SocketAddress> bound = listening(env());
        assertEquals(3, bound.size(), "two FIX sockets and the ingest listener: " + bound);
        for (SocketAddress a : bound) {
            assertTrue(((InetSocketAddress) a).getAddress().isAnyLocalAddress(), "not every interface: " + a);
        }
    }

    private static List<SocketAddress> listening(Map<String, String> env) throws Exception {
        FixAcceptorMain.Started started = FixAcceptorMain.start(env);
        assertTrue(started.ok, started.errorCode + " " + started.errorMessage);
        try (FixAcceptorMain.Running running = started.running) {
            return running.listenAddresses();
        }
    }

    private static Map<String, String> env() throws Exception {
        Map<String, String> env = new LinkedHashMap<>();
        env.put(FixAcceptorConfig.BEGIN_STRING_ENV, "FIX.4.4");
        env.put(FixAcceptorConfig.SENDER_COMP_ID_ENV, "INTAFACED-TEST");
        env.put(FixAcceptorConfig.TARGET_COMP_ID_ENV, "TEST-CLIENT");
        env.put(FixAcceptorConfig.SOCKET_ACCEPT_PORT_ENV, Integer.toString(freePort()));
        env.put(FixAcceptorConfig.HEARTBTINT_ENV, "30");
        env.put(FixDropCopyConfig.BEGIN_STRING_ENV, "FIX.4.4");
        env.put(FixDropCopyConfig.SENDER_COMP_ID_ENV, "INTAFACED-TEST-DC");
        env.put(FixDropCopyConfig.TARGET_COMP_ID_ENV, "TEST-CLIENT-DC");
        env.put(FixDropCopyConfig.SOCKET_ACCEPT_PORT_ENV, Integer.toString(freePort()));
        env.put(FixDropCopyConfig.HEARTBTINT_ENV, "30");
        env.put(DropCopyIngestConfig.PORT_ENV, Integer.toString(freePort()));
        // Nothing listens here: this test sends no order.
        env.put(MatchingSubmitPort.BASE_URL_ENV, "http://127.0.0.1:9");
        env.put(ServiceAuth.SECRET_ENV, "a-fix-listen-host-fleet-secret-long-enough");
        return env;
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        }
    }
}
