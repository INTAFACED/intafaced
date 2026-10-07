package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDateTime;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import quickfix.FixVersions;
import quickfix.Message;
import quickfix.SessionID;
import quickfix.field.ClOrdID;
import quickfix.field.CumQty;
import quickfix.field.ExecID;
import quickfix.field.ExecType;
import quickfix.field.MsgSeqNum;
import quickfix.field.MsgType;
import quickfix.field.OrdType;
import quickfix.field.OrderQty;
import quickfix.field.PossDupFlag;
import quickfix.field.PossResend;
import quickfix.field.Price;
import quickfix.field.SenderCompID;
import quickfix.field.SendingTime;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.TargetCompID;
import quickfix.field.TimeInForce;
import quickfix.field.TransactTime;
import quickfix.fix44.NewOrderSingle;

class FixSessionNosMatchingTest {
    private static final String OWNER_MAP = "{\"CLIENT\":\"acct-desk\"}";
    private static final SessionID SESSION = new SessionID(FixVersions.BEGINSTRING_FIX44, "INTAFACED", "CLIENT");

    @Test
    void nosPostsMatchingAndExecutionReportUsesMatchingSequence() throws Exception {
        AtomicReference<String> posted = new AtomicReference<>();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, "a".repeat(32), (url, json, headers) -> {
            posted.set(json);
            return new MatchingSubmitPort.Transport.Response(
                    200, "{\"accepted\":true,\"sequence\":9,\"fills\":[{\"price\":99.5}],\"last\":99.5,\"account\":\"ghost\"}");
        });
        FixSessionApplication app = new FixSessionApplication(new FixGatewayAdapter(), port);
        app.fromApp(limitNos(), SESSION);
        assertEquals(1, app.matchingPosts());
        assertTrue(posted.get().contains("\"qty\":\"1.50\""));
        assertEquals(1, app.outbound().size());
        Message er = app.outbound().get(0);
        assertEquals(MsgType.EXECUTION_REPORT, er.getHeader().getString(MsgType.FIELD));
        assertEquals("9", er.getString(ExecID.FIELD));
        assertEquals(ExecType.NEW, er.getChar(ExecType.FIELD));
        assertEquals("0", er.getString(CumQty.FIELD));
        assertFalse(er.isSetField(quickfix.field.LastPx.FIELD));
        assertFalse(er.isSetField(quickfix.field.LastQty.FIELD));
        assertFalse(er.isSetField(quickfix.field.Account.FIELD));
        assertFalse(er.toString().contains("99.5"));
        assertFalse(er.toString().contains("ledger"));
    }

    @Test
    void possDupOrPossResendNewOrderSingleIsNotPostedToMatching() throws Exception {
        AtomicInteger posts = new AtomicInteger();
        MatchingSubmitPort port = new MatchingSubmitPort(
                "http://matching.example", OWNER_MAP, "a".repeat(32), (url, json, headers) -> {
                    posts.incrementAndGet();
                    return new MatchingSubmitPort.Transport.Response(
                            200, "{\"accepted\":true,\"sequence\":9}");
                });
        FixSessionApplication app = new FixSessionApplication(new FixGatewayAdapter(), port);

        app.fromApp(limitNos(), SESSION);
        assertEquals(1, posts.get());
        assertEquals(1, app.matchingPosts());
        assertEquals(MsgType.EXECUTION_REPORT, app.outbound().get(0).getHeader().getString(MsgType.FIELD));

        NewOrderSingle possDup = limitNos();
        possDup.getHeader().setBoolean(PossDupFlag.FIELD, true);
        app.fromApp(possDup, SESSION);
        assertEquals(1, posts.get(), "PossDupFlag Y was posted to matching again");
        assertEquals(1, app.matchingPosts());

        NewOrderSingle possResend = limitNos();
        possResend.getHeader().setBoolean(PossResend.FIELD, true);
        app.fromApp(possResend, SESSION);
        assertEquals(1, posts.get(), "PossResend Y was posted to matching again");
        assertEquals(1, app.matchingPosts());

        assertEquals(3, app.outbound().size());
        assertSessionReject(app.outbound().get(1), "PossDupFlag");
        assertSessionReject(app.outbound().get(2), "PossResend");
    }

    @Test
    void unmappedCompIdDoesNotPostMatching() throws Exception {
        MatchingSubmitPort port = new MatchingSubmitPort("http://matching.example", OWNER_MAP, "a".repeat(32), (url, json, headers) -> {
            throw new AssertionError("must not POST");
        });
        FixSessionApplication app = new FixSessionApplication(new FixGatewayAdapter(), port);
        NewOrderSingle nos = limitNos();
        nos.getHeader().setString(SenderCompID.FIELD, "GHOST");
        app.fromApp(nos, SESSION);
        assertEquals(0, app.matchingPosts());
        assertEquals(1, app.outbound().size());
        assertEquals(MsgType.REJECT, app.outbound().get(0).getHeader().getString(MsgType.FIELD));
        assertTrue(app.outbound().get(0).getString(quickfix.field.Text.FIELD).contains("invent an account"));
    }

    @Test
    void executionReportDoesNotMintLastFromIeeeAck() throws Exception {
        Message er = ExecutionReportFactory.fromAck(
                new MatchingOrderCommand(
                        "clid", FixVersions.BEGINSTRING_FIX44, null, "BTC/USDT", "buy", "limit", "1.50", "100.25", "CLIENT", "GTC"),
                new MatchingAck(true, 3L));
        assertEquals("3", er.getString(ExecID.FIELD));
        assertFalse(er.isSetField(quickfix.field.LastPx.FIELD));
        assertFalse(er.toString().contains("100.25"));
    }

    private static void assertSessionReject(Message reject, String flagName) throws Exception {
        assertEquals(MsgType.REJECT, reject.getHeader().getString(MsgType.FIELD));
        assertEquals(MsgType.NEW_ORDER_SINGLE, reject.getString(quickfix.field.RefMsgType.FIELD));
        assertTrue(reject.getString(quickfix.field.Text.FIELD).contains(flagName), reject.getString(quickfix.field.Text.FIELD));
        assertFalse(reject.isSetField(ExecID.FIELD));
        assertFalse(reject.isSetField(ExecType.FIELD));
        assertFalse(reject.isSetField(Price.FIELD));
        assertFalse(reject.toString().contains("100.25"));
    }

    private static NewOrderSingle limitNos() {
        NewOrderSingle nos = new NewOrderSingle();
        nos.getHeader().setString(quickfix.field.BeginString.FIELD, FixVersions.BEGINSTRING_FIX44);
        nos.getHeader().setString(SenderCompID.FIELD, "CLIENT");
        nos.getHeader().setString(TargetCompID.FIELD, "INTAFACED");
        nos.getHeader().setInt(MsgSeqNum.FIELD, 2);
        nos.getHeader().setUtcTimeStamp(SendingTime.FIELD, LocalDateTime.of(2026, 9, 2, 12, 0, 0), true);
        nos.set(new ClOrdID("clid-c2"));
        nos.set(new Symbol("BTC/USDT"));
        nos.set(new Side(Side.BUY));
        nos.set(new TransactTime(LocalDateTime.of(2026, 9, 2, 12, 0, 0)));
        nos.set(new OrdType(OrdType.LIMIT));
        nos.setString(OrderQty.FIELD, "1.50");
        nos.setString(Price.FIELD, "100.25");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        return nos;
    }
}
