package io.intafaced.fix;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDateTime;
import org.junit.jupiter.api.Test;
import quickfix.FieldNotFound;
import quickfix.FixVersions;
import quickfix.Message;
import quickfix.field.ClOrdID;
import quickfix.field.ExpireDate;
import quickfix.field.ExpireTime;
import quickfix.field.HandlInst;
import quickfix.field.MaxFloor;
import quickfix.field.MinQty;
import quickfix.field.MsgSeqNum;
import quickfix.field.OrdType;
import quickfix.field.OrderQty;
import quickfix.field.Price;
import quickfix.field.SenderCompID;
import quickfix.field.SendingTime;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.TargetCompID;
import quickfix.field.TimeInForce;
import quickfix.field.TransactTime;
import quickfix.fix42.NewOrderSingle;

class FixGatewayAdapterTest {
    private final FixGatewayAdapter adapter = new FixGatewayAdapter();

    @Test
    void fix44LimitMapsDecimalStringsNotNumbers() throws Exception {
        String raw = limit44("clid-44", "BTC/USDT", "1.50", "100.25");
        AdaptResult result = adapter.adapt(raw);
        assertTrue(result.ok, result.toJson());
        MatchingOrderCommand cmd = result.command;
        assertEquals("new_order_single", cmd.kind);
        assertEquals("clid-44", cmd.clOrdId);
        assertEquals(FixVersions.BEGINSTRING_FIX44, cmd.beginString);
        assertEquals("BTC/USDT", cmd.symbol);
        assertEquals("buy", cmd.side);
        assertEquals("limit", cmd.ordType);
        assertEquals("1.50", cmd.qty);
        assertEquals("100.25", cmd.price);
        assertEquals("CLIENT", cmd.senderCompId);
        assertEquals("GTC", cmd.tif);
        String json = result.toJson();
        assertTrue(json.contains("\"senderCompId\":\"CLIENT\""), json);
        assertTrue(json.contains("\"tif\":\"GTC\""), json);
        assertTrue(json.contains("\"qty\":\"1.50\""), json);
        assertTrue(json.contains("\"price\":\"100.25\""), json);
        assertFalse(json.contains("\"qty\":1.50"), json);
        assertFalse(json.contains("\"price\":100.25"), json);
        assertFalse(json.contains("lastQty"));
        assertFalse(json.contains("cumQty"));
        assertFalse(json.contains("avgPx"));
        assertFalse(json.contains("ExecType"));
        assertFalse(json.contains("ledger"));
        assertFalse(json.contains("balance"));
    }

    @Test
    void fix42IsSupported() throws Exception {
        NewOrderSingle nos = new NewOrderSingle();
        stampHeader(nos, FixVersions.BEGINSTRING_FIX42);
        nos.set(new ClOrdID("clid-42"));
        nos.setString(HandlInst.FIELD, "1");
        nos.set(new Symbol("ETH/USDT"));
        nos.set(new Side(Side.SELL));
        nos.set(new TransactTime(LocalDateTime.of(2026, 9, 1, 12, 0, 0)));
        nos.set(new OrdType(OrdType.LIMIT));
        nos.setString(OrderQty.FIELD, "2.00");
        nos.setString(Price.FIELD, "9.5");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        AdaptResult result = adapter.adapt(nos.toString());
        assertTrue(result.ok, result.toJson());
        assertEquals(FixVersions.BEGINSTRING_FIX42, result.command.beginString);
        assertEquals("2.00", result.command.qty);
        assertEquals("sell", result.command.side);
        assertTrue(result.toJson().contains("\"qty\":\"2.00\""));
    }

    @Test
    void fixt11Fix50IsSupported() throws Exception {
        quickfix.fix50.NewOrderSingle nos = new quickfix.fix50.NewOrderSingle();
        stampHeader(nos, FixVersions.BEGINSTRING_FIXT11);
        nos.getHeader().setString(quickfix.field.ApplVerID.FIELD, FixVersions.FIX50);
        nos.set(new ClOrdID("clid-50"));
        nos.set(new Symbol("BTC/USDT"));
        nos.set(new Side(Side.BUY));
        nos.set(new TransactTime(LocalDateTime.of(2026, 9, 1, 12, 0, 0)));
        nos.set(new OrdType(OrdType.MARKET));
        nos.setString(OrderQty.FIELD, "0.010");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        AdaptResult result = adapter.adapt(nos.toString());
        assertTrue(result.ok, result.toJson());
        assertEquals(FixVersions.BEGINSTRING_FIXT11, result.command.beginString);
        assertEquals("market", result.command.ordType);
        assertEquals("0.010", result.command.qty);
        assertNull(result.command.price);
        assertTrue(result.toJson().contains("\"price\":null"));
        assertTrue(result.toJson().contains("\"qty\":\"0.010\""));
    }

    @Test
    void unsupportedBeginStringRefuses() throws Exception {
        Message nos = new Message();
        stampHeader(nos, FixVersions.BEGINSTRING_FIX40);
        nos.getHeader().setString(quickfix.field.MsgType.FIELD, "D");
        nos.setString(ClOrdID.FIELD, "x");
        nos.setString(Symbol.FIELD, "BTC/USDT");
        nos.setString(Side.FIELD, "1");
        nos.setString(OrdType.FIELD, "2");
        nos.setString(OrderQty.FIELD, "1");
        nos.setString(Price.FIELD, "1");
        nos.setUtcTimeStamp(TransactTime.FIELD, LocalDateTime.of(2026, 9, 1, 12, 0, 0), true);
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok);
        assertEquals("unsupported_begin_string", result.errorCode);
        assertNull(result.command);
    }

    @Test
    void missingClOrdIdRefuses() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.removeField(ClOrdID.FIELD);
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok, result.toJson());
        assertEquals("missing_cl_ord_id", result.errorCode);
    }

    @Test
    void unsupportedTagRefuses() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.setString(9999, "nope");
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok, result.toJson());
        assertEquals("unsupported_tag", result.errorCode);
        assertNotNull(result.errorMessage);
        assertTrue(result.errorMessage.contains("9999") || result.errorMessage.toLowerCase().contains("tag"));
    }

    @Test
    void qtyNeverBecomesJsonNumber() throws Exception {
        String json = adapter.adapt(limit44("n", "AAA/BBB", "10.000000000000000001", "1.0")).toJson();
        assertTrue(json.contains("\"qty\":\"10.000000000000000001\""), json);
        assertFalse(json.matches("(?s).*\"qty\":[0-9].*"), json);
        assertFalse(json.matches("(?s).*\"price\":[0-9].*"), json);
    }

    @Test
    void missingTimeInForceRefusesTifMissing() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.removeField(TimeInForce.FIELD);
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok, result.toJson());
        assertEquals("tif_missing", result.errorCode);
        assertTrue(result.errorMessage.contains("invent GTC"));
    }

    @Test
    void marketOrderForwardsProtectionPriceAsDecimalString() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.set(new OrdType(OrdType.MARKET));
        nos.setString(OrderQty.FIELD, "1.50");
        nos.setString(Price.FIELD, "101.50");
        AdaptResult result = adapter.adapt(nos.toString());
        assertTrue(result.ok, result.toJson());
        assertEquals("market", result.command.ordType);
        assertEquals("1.50", result.command.qty);
        assertEquals("101.50", result.command.price);
        String json = result.toJson();
        assertTrue(json.contains("\"price\":\"101.50\""), json);
        assertFalse(json.contains("\"price\":null"), json);
        assertFalse(json.contains("\"price\":101.50"), json);
        assertFalse(json.contains("ledger"));
        assertFalse(json.contains("balance"));
    }

    @Test
    void marketOrderWithoutPriceStaysNull() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.set(new OrdType(OrdType.MARKET));
        nos.removeField(Price.FIELD);
        AdaptResult result = adapter.adapt(nos.toString());
        assertTrue(result.ok, result.toJson());
        assertEquals("market", result.command.ordType);
        assertNull(result.command.price);
        assertTrue(result.toJson().contains("\"price\":null"));
        assertFalse(result.toJson().contains("ledger"));
    }

    @Test
    void blankOrNonDecimalPriceRefuses() throws Exception {
        for (String price : new String[] {"", " ", "abc", "1e-2", "-1", "1.1234567890123456789"}) {
            quickfix.fix44.NewOrderSingle market = baseLimit44();
            market.set(new OrdType(OrdType.MARKET));
            market.setString(Price.FIELD, price);
            AdaptResult marketResult = adapter.adapt(market.toString());
            assertFalse(marketResult.ok, price + " " + marketResult.toJson());
            assertNull(marketResult.command);
            assertTrue(
                    "invalid_decimal".equals(marketResult.errorCode) || "invalid_message".equals(marketResult.errorCode),
                    price + " " + marketResult.toJson());

            quickfix.fix44.NewOrderSingle limit = baseLimit44();
            limit.setString(Price.FIELD, price);
            AdaptResult limitResult = adapter.adapt(limit.toString());
            assertFalse(limitResult.ok, price + " " + limitResult.toJson());
            assertNull(limitResult.command);
            assertTrue(
                    "invalid_decimal".equals(limitResult.errorCode) || "invalid_message".equals(limitResult.errorCode),
                    price + " " + limitResult.toJson());
        }
    }

    @Test
    void gtdWithoutExpireTimeOrExpireDateRefuses() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_DATE));
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok, result.toJson());
        assertEquals("gtd_expiry_missing", result.errorCode);
        assertNull(result.command);
        assertTrue(result.errorMessage.contains("does not invent an expiry"), result.errorMessage);
        assertFalse(result.toJson().contains("ledger"));
    }

    @Test
    void gtdWithExpireTimeOrExpireDateIsAccepted() throws Exception {
        quickfix.fix44.NewOrderSingle byTime = baseLimit44();
        byTime.set(new TimeInForce(TimeInForce.GOOD_TILL_DATE));
        byTime.set(new ExpireTime(LocalDateTime.of(2026, 9, 2, 15, 30, 0)));
        AdaptResult timed = adapter.adapt(byTime.toString());
        assertTrue(timed.ok, timed.toJson());
        assertEquals("GTD", timed.command.tif);
        assertEquals("1", timed.command.price);

        quickfix.fix44.NewOrderSingle byDate = baseLimit44();
        byDate.set(new TimeInForce(TimeInForce.GOOD_TILL_DATE));
        byDate.set(new ExpireDate("20260902"));
        AdaptResult dated = adapter.adapt(byDate.toString());
        assertTrue(dated.ok, dated.toJson());
        assertEquals("GTD", dated.command.tif);
    }

    @Test
    void minQtyOrMaxFloorRefusesRatherThanDropping() throws Exception {
        quickfix.fix44.NewOrderSingle minQty = baseLimit44();
        minQty.setString(MinQty.FIELD, "0.25");
        AdaptResult minResult = adapter.adapt(minQty.toString());
        assertFalse(minResult.ok, minResult.toJson());
        assertEquals("unmapped_economic_tag", minResult.errorCode);
        assertNull(minResult.command);
        assertTrue(minResult.errorMessage.contains("MinQty"), minResult.errorMessage);
        assertTrue(minResult.errorMessage.contains("inventing a quantity"), minResult.errorMessage);
        assertFalse(minResult.toJson().contains("0.25"));

        quickfix.fix44.NewOrderSingle maxFloor = baseLimit44();
        maxFloor.setString(MaxFloor.FIELD, "3.00");
        AdaptResult floorResult = adapter.adapt(maxFloor.toString());
        assertFalse(floorResult.ok, floorResult.toJson());
        assertEquals("unmapped_economic_tag", floorResult.errorCode);
        assertNull(floorResult.command);
        assertTrue(floorResult.errorMessage.contains("MaxFloor"), floorResult.errorMessage);
        assertFalse(floorResult.toJson().contains("3.00"));
        assertFalse(floorResult.toJson().contains("ledger"));
    }

    @Test
    void blankSenderCompIdRefusesUnmapped() throws Exception {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.getHeader().setString(SenderCompID.FIELD, "");
        AdaptResult result = adapter.adapt(nos.toString());
        assertFalse(result.ok, result.toJson());
        assertEquals("matching_account_unmapped", result.errorCode);
        assertTrue(result.errorMessage.contains("invent an account"));
    }

    private static String limit44(String clOrdId, String symbol, String qty, String price) throws FieldNotFound {
        quickfix.fix44.NewOrderSingle nos = baseLimit44();
        nos.set(new ClOrdID(clOrdId));
        nos.set(new Symbol(symbol));
        nos.setString(OrderQty.FIELD, qty);
        nos.setString(Price.FIELD, price);
        return nos.toString();
    }

    private static quickfix.fix44.NewOrderSingle baseLimit44() {
        quickfix.fix44.NewOrderSingle nos = new quickfix.fix44.NewOrderSingle();
        stampHeader(nos, FixVersions.BEGINSTRING_FIX44);
        nos.set(new ClOrdID("clid"));
        nos.set(new Symbol("BTC/USDT"));
        nos.set(new Side(Side.BUY));
        nos.set(new TransactTime(LocalDateTime.of(2026, 9, 1, 12, 0, 0)));
        nos.set(new OrdType(OrdType.LIMIT));
        nos.setString(OrderQty.FIELD, "1");
        nos.setString(Price.FIELD, "1");
        nos.set(new TimeInForce(TimeInForce.GOOD_TILL_CANCEL));
        return nos;
    }

    private static void stampHeader(Message message, String beginString) {
        message.getHeader().setString(quickfix.field.BeginString.FIELD, beginString);
        message.getHeader().setString(SenderCompID.FIELD, "CLIENT");
        message.getHeader().setString(TargetCompID.FIELD, "INTAFACED");
        message.getHeader().setInt(MsgSeqNum.FIELD, 1);
        message.getHeader().setUtcTimeStamp(SendingTime.FIELD, LocalDateTime.of(2026, 9, 1, 12, 0, 0), true);
    }
}
