package io.intafaced.fix;

import quickfix.FixVersions;
import quickfix.Message;
import quickfix.field.ClOrdID;
import quickfix.field.CumQty;
import quickfix.field.ExecID;
import quickfix.field.ExecTransType;
import quickfix.field.ExecType;
import quickfix.field.LastPx;
import quickfix.field.LastQty;
import quickfix.field.LeavesQty;
import quickfix.field.OrdStatus;
import quickfix.field.OrderID;
import quickfix.field.OrderQty;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.Text;

/**
 * ExecutionReport from matching's named ack, or from an ingest fill.
 * Ack path: no last/fills/account. Fill path: LastPx/LastQty are this print's
 * decimal strings. A null price or qty is refused. This print is not CumQty
 * or AvgPx. ExecID is matching sequence or fillId/sequence already on the
 * fill. Never a UUID. No ledger.
 */
public final class ExecutionReportFactory {
    private ExecutionReportFactory() {}

    public static Message fromAck(MatchingOrderCommand command, MatchingAck ack) {
        if (ack == null || !ack.accepted || ack.sequence == null) {
            return reject(command, "matching ack has no sequence; svc-fix does not invent ExecID");
        }
        Message er = newReport(command.beginString);
        er.setString(OrderID.FIELD, command.clOrdId);
        er.setString(ClOrdID.FIELD, command.clOrdId);
        er.setString(ExecID.FIELD, Long.toString(ack.sequence));
        if (FixVersions.BEGINSTRING_FIX42.equals(command.beginString)) {
            er.setChar(ExecTransType.FIELD, ExecTransType.NEW);
        }
        er.setChar(ExecType.FIELD, ExecType.NEW);
        er.setChar(OrdStatus.FIELD, OrdStatus.NEW);
        er.setChar(Side.FIELD, side(command.side));
        er.setString(Symbol.FIELD, command.symbol);
        er.setString(OrderQty.FIELD, command.qty);
        er.setString(LeavesQty.FIELD, command.qty);
        er.setString(CumQty.FIELD, "0");
        return er;
    }

    /**
     * House-book partial fill. Missing fillId and sequence refuse — do not mint ExecID.
     * A null price or qty refuses the report. LastPx and LastQty are this print.
     * CumQty and AvgPx are not copied from this print, and no price is invented.
     * FIX 4.2 ExecType is partial fill, never a complete fill.
     */
    public static Message fromFill(String beginString, DropCopyFill fill) {
        if (fill == null || fill.execId() == null || fill.price == null || fill.qty == null) {
            return null;
        }
        Message er = newReport(beginString);
        if (fill.orderId != null && !fill.orderId.isBlank()) {
            er.setString(OrderID.FIELD, fill.orderId);
            er.setString(ClOrdID.FIELD, fill.orderId);
        }
        er.setString(ExecID.FIELD, fill.execId());
        if (FixVersions.BEGINSTRING_FIX42.equals(beginString)) {
            er.setChar(ExecTransType.FIELD, ExecTransType.NEW);
            er.setChar(ExecType.FIELD, ExecType.PARTIAL_FILL);
        } else {
            er.setChar(ExecType.FIELD, ExecType.TRADE);
        }
        er.setChar(OrdStatus.FIELD, OrdStatus.PARTIALLY_FILLED);
        if (fill.side != null) {
            er.setChar(Side.FIELD, side(fill.side));
        }
        if (fill.marketId != null && !fill.marketId.isBlank()) {
            er.setString(Symbol.FIELD, fill.marketId);
        }
        er.setString(LastQty.FIELD, fill.qty);
        er.setString(LastPx.FIELD, fill.price);
        return er;
    }

    public static Message reject(MatchingOrderCommand command, String text) {
        Message er = newReport(command.beginString);
        er.setString(OrderID.FIELD, command.clOrdId);
        er.setString(ClOrdID.FIELD, command.clOrdId);
        er.setString(ExecID.FIELD, command.clOrdId);
        if (FixVersions.BEGINSTRING_FIX42.equals(command.beginString)) {
            er.setChar(ExecTransType.FIELD, ExecTransType.NEW);
        }
        er.setChar(ExecType.FIELD, ExecType.REJECTED);
        er.setChar(OrdStatus.FIELD, OrdStatus.REJECTED);
        er.setChar(Side.FIELD, side(command.side));
        er.setString(Symbol.FIELD, command.symbol);
        er.setString(OrderQty.FIELD, command.qty);
        er.setString(LeavesQty.FIELD, command.qty);
        er.setString(CumQty.FIELD, "0");
        er.setString(Text.FIELD, text);
        return er;
    }

    private static Message newReport(String beginString) {
        if (FixVersions.BEGINSTRING_FIX42.equals(beginString)) {
            return new quickfix.fix42.ExecutionReport();
        }
        if (FixVersions.BEGINSTRING_FIXT11.equals(beginString) || FixVersions.FIX50.equals(beginString)) {
            return new quickfix.fix50.ExecutionReport();
        }
        return new quickfix.fix44.ExecutionReport();
    }

    private static char side(String side) {
        if ("sell".equals(side) || "2".equals(side)) {
            return Side.SELL;
        }
        return Side.BUY;
    }
}
