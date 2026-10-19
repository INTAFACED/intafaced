package io.intafaced.fix;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import quickfix.ApplicationAdapter;
import quickfix.FieldNotFound;
import quickfix.Message;
import quickfix.Session;
import quickfix.SessionID;
import quickfix.field.MsgSeqNum;
import quickfix.field.MsgType;
import quickfix.field.PossDupFlag;
import quickfix.field.PossResend;
import quickfix.field.RefMsgType;
import quickfix.field.RefSeqNum;
import quickfix.field.Text;

/**
 * Live FIX order-entry session. C2: NOS after account+TIF map posts matching.
 * ExecutionReport from matching sequence is also the included drop-copy FIX source.
 * No ledger. No invented last/fill/account.
 */
public final class FixSessionApplication extends ApplicationAdapter {
    public final CountDownLatch loggedOn = new CountDownLatch(1);
    public final CountDownLatch loggedOut = new CountDownLatch(1);
    private final AtomicInteger matchingPosts = new AtomicInteger(0);
    private final List<String> adminMsgTypes = new ArrayList<>();
    private final List<String> appMsgTypes = new ArrayList<>();
    private final List<Message> outbound = new ArrayList<>();
    private final FixGatewayAdapter adapter;
    private final MatchingSubmitPort matching;
    private final DropCopyHub dropCopy;

    public FixSessionApplication() {
        this(new FixGatewayAdapter(), MatchingSubmitPort.fromEnv(), DropCopyHub.disabled());
    }

    public FixSessionApplication(FixGatewayAdapter adapter, MatchingSubmitPort matching) {
        this(adapter, matching, DropCopyHub.disabled());
    }

    public FixSessionApplication(FixGatewayAdapter adapter, MatchingSubmitPort matching, DropCopyHub dropCopy) {
        this.adapter = adapter;
        this.matching = matching;
        this.dropCopy = dropCopy == null ? DropCopyHub.disabled() : dropCopy;
    }

    @Override
    public void onLogon(SessionID sessionId) {
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
        if (!MsgType.NEW_ORDER_SINGLE.equals(msgType)) {
            AdaptResult refused = adapter.adapt(message.toString());
            sendSessionReject(
                    message,
                    sessionId,
                    refused.ok ? "only NewOrderSingle (35=D) is mapped" : refused.errorMessage);
            return;
        }
        if (headerYes(message, PossDupFlag.FIELD) || headerYes(message, PossResend.FIELD)) {
            sendSessionReject(
                    message,
                    sessionId,
                    "PossDupFlag (43) or PossResend (97) is Y; svc-fix refuses a resent NewOrderSingle rather than posting it to matching again");
            return;
        }
        AdaptResult adapted = adapter.adapt(message.toString());
        if (!adapted.ok) {
            sendSessionReject(message, sessionId, adapted.errorMessage);
            return;
        }
        MatchingSubmitResult posted = matching.submit(adapted.command);
        if (posted.httpSent) {
            matchingPosts.incrementAndGet();
        }
        if (!posted.ok) {
            sendSessionReject(message, sessionId, posted.errorMessage);
            return;
        }
        if (posted.ack == null || posted.ack.sequence == null) {
            sendSessionReject(message, sessionId, "matching ack has no sequence; svc-fix does not invent ExecID");
            return;
        }
        Message er = ExecutionReportFactory.fromAck(adapted.command, posted.ack);
        send(er, sessionId);
        dropCopy.publish(DropCopyCatalog.FIX, er);
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

    private void send(Message outboundMessage, SessionID sessionId) {
        synchronized (this) {
            outbound.add(outboundMessage);
        }
        Session session = Session.lookupSession(sessionId);
        if (session != null) {
            session.send(outboundMessage);
        }
    }

    private synchronized void record(List<String> into, Message message) throws FieldNotFound {
        into.add(message.getHeader().getString(MsgType.FIELD));
    }

    private static boolean headerYes(Message message, int field) throws FieldNotFound {
        return message.getHeader().isSetField(field) && message.getHeader().getBoolean(field);
    }
}
