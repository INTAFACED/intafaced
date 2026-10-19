package io.intafaced.fix;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import quickfix.ApplicationAdapter;
import quickfix.FieldNotFound;
import quickfix.Message;
import quickfix.Session;
import quickfix.SessionID;
import quickfix.field.MsgSeqNum;
import quickfix.field.MsgType;
import quickfix.field.RefMsgType;
import quickfix.field.RefSeqNum;
import quickfix.field.Text;

/**
 * Independent drop-copy QFJ session. Not order-entry. No matching POST. No ledger.
 * Streams included sources only. Completeness claims refuse while sources are missing.
 */
public final class FixDropCopyApplication extends ApplicationAdapter {
    public final CountDownLatch loggedOn = new CountDownLatch(1);
    public final CountDownLatch loggedOut = new CountDownLatch(1);
    private final AtomicInteger matchingPosts = new AtomicInteger(0);
    private final List<String> adminMsgTypes = new ArrayList<>();
    private final List<String> appMsgTypes = new ArrayList<>();
    private final List<Message> outbound = new ArrayList<>();
    /** Executions and rejects not yet passed to {@link Session#send}. */
    private final List<Message> unsent = new ArrayList<>();
    private final AtomicReference<SessionID> sessionId = new AtomicReference<>();
    private boolean flushing;
    private boolean flushAgain;
    private final DropCopyHub hub;

    public FixDropCopyApplication() {
        this(new DropCopyHub());
    }

    public FixDropCopyApplication(DropCopyHub hub) {
        this.hub = hub == null ? new DropCopyHub() : hub;
        this.hub.attach(this);
    }

    public DropCopyCompleteness claimComplete() {
        return hub.claimComplete();
    }

    public List<String> includedSources() {
        return hub.included();
    }

    public DropCopyPublishResult publish(String source, Message execution) {
        return hub.publish(source, execution);
    }

    @Override
    public void onLogon(SessionID sessionId) {
        synchronized (this) {
            this.sessionId.set(sessionId);
        }
        flushUnsent(sessionId);
        loggedOn.countDown();
    }

    @Override
    public void onLogout(SessionID sessionId) {
        loggedOut.countDown();
    }

    @Override
    public void fromAdmin(Message message, SessionID sessionId) throws FieldNotFound {
        record(adminMsgTypes, message);
    }

    @Override
    public void toAdmin(Message message, SessionID sessionId) {
        try {
            record(adminMsgTypes, message);
        } catch (FieldNotFound ignored) {
            // QFJ still sends the admin message.
        }
    }

    @Override
    public void fromApp(Message message, SessionID sessionId) throws FieldNotFound {
        record(appMsgTypes, message);
        String msgType = message.getHeader().getString(MsgType.FIELD);
        if (MsgType.NEW_ORDER_SINGLE.equals(msgType)) {
            sendSessionReject(message, sessionId, "drop-copy is not the order-entry session; svc-fix does not take NewOrderSingle here");
        }
    }

    public void deliver(Message execution) {
        send(execution, null);
    }

    public int matchingPosts() {
        return matchingPosts.get();
    }

    public synchronized List<String> adminMsgTypes() {
        return List.copyOf(adminMsgTypes);
    }

    public synchronized List<String> appMsgTypes() {
        return List.copyOf(appMsgTypes);
    }

    public synchronized List<Message> outbound() {
        return List.copyOf(outbound);
    }

    private void sendSessionReject(Message inbound, SessionID sessionId, String text) {
        Message reject = new Message();
        reject.getHeader().setString(MsgType.FIELD, MsgType.REJECT);
        try {
            reject.setInt(RefSeqNum.FIELD, inbound.getHeader().getInt(MsgSeqNum.FIELD));
        } catch (FieldNotFound ignored) {
            // RefSeqNum stays unset rather than inventing a sequence.
        }
        try {
            reject.setString(RefMsgType.FIELD, inbound.getHeader().getString(MsgType.FIELD));
        } catch (FieldNotFound ignored) {
            reject.setString(RefMsgType.FIELD, MsgType.NEW_ORDER_SINGLE);
        }
        reject.setString(Text.FIELD, text);
        send(reject, sessionId);
    }

    private void send(Message outboundMessage, SessionID explicitSessionId) {
        synchronized (this) {
            outbound.add(outboundMessage);
            unsent.add(outboundMessage);
        }
        flushUnsent(explicitSessionId);
    }

    /**
     * Hand queued messages to a session that is already logged on.
     * Lookup miss or a session that is not logged on leaves them queued:
     * no session is created and no sequence is written.
     * Messages already passed to {@link Session#send} are not in {@code unsent}.
     */
    private void flushUnsent(SessionID preferred) {
        synchronized (this) {
            if (flushing) {
                flushAgain = true;
                return;
            }
            flushing = true;
        }
        try {
            drainUnsent(preferred);
        } finally {
            boolean again;
            synchronized (this) {
                flushing = false;
                again = flushAgain;
                flushAgain = false;
            }
            if (again) {
                flushUnsent(null);
            }
        }
    }

    private void drainUnsent(SessionID preferred) {
        while (true) {
            SessionID id;
            synchronized (this) {
                id = preferred != null ? preferred : sessionId.get();
            }
            if (id == null) {
                return;
            }
            Session session = Session.lookupSession(id);
            if (session == null || !session.isLoggedOn()) {
                return;
            }
            Message next;
            synchronized (this) {
                if (unsent.isEmpty()) {
                    return;
                }
                next = unsent.remove(0);
            }
            session.send(next);
        }
    }

    private synchronized void record(List<String> into, Message message) throws FieldNotFound {
        into.add(message.getHeader().getString(MsgType.FIELD));
    }
}
