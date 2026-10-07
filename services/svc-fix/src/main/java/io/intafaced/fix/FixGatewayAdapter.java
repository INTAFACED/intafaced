package io.intafaced.fix;

import java.io.InputStream;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import quickfix.ConfigError;
import quickfix.DataDictionary;
import quickfix.Field;
import quickfix.FieldNotFound;
import quickfix.FixVersions;
import quickfix.InvalidMessage;
import quickfix.Message;
import quickfix.ValidationSettings;
import quickfix.field.ApplVerID;
import quickfix.field.BeginString;
import quickfix.field.ClOrdID;
import quickfix.field.ExpireDate;
import quickfix.field.ExpireTime;
import quickfix.field.MaxFloor;
import quickfix.field.MinQty;
import quickfix.field.MsgType;
import quickfix.field.OrdType;
import quickfix.field.OrderQty;
import quickfix.field.Price;
import quickfix.field.SenderCompID;
import quickfix.field.Side;
import quickfix.field.Symbol;
import quickfix.field.TimeInForce;

/**
 * QuickFIX/J adapter: FIX NewOrderSingle → matching command.
 * Does not post value, hold accounts, or emit fills.
 */
public final class FixGatewayAdapter {
    public static final Set<String> SUPPORTED_BEGIN_STRINGS = Set.of(
            FixVersions.BEGINSTRING_FIX42,
            FixVersions.BEGINSTRING_FIX44,
            FixVersions.FIX50,
            FixVersions.BEGINSTRING_FIXT11);

    private static final String MSG_NEW_ORDER_SINGLE = "D";
    private static final Pattern DECIMAL = Pattern.compile("^\\d+(\\.\\d{1,18})?$");
    private static final char SOH = '\u0001';

    private final Map<String, DataDictionary> dictionaries = new ConcurrentHashMap<>();

    public AdaptResult adapt(String rawFix) {
        if (rawFix == null || rawFix.isEmpty()) {
            return AdaptResult.refuse("invalid_message", "empty FIX payload");
        }
        // String.trim() strips SOH (U+0001 <= U+0020) and would break the checksum trailer.
        String wire = normalizeSoh(stripWrappingNewlines(rawFix));
        Message probe;
        try {
            probe = parseProbe(wire);
        } catch (InvalidMessage e) {
            return AdaptResult.refuse("invalid_message", e.getMessage());
        }
        String begin;
        try {
            begin = probe.getHeader().getString(BeginString.FIELD);
        } catch (FieldNotFound e) {
            return AdaptResult.refuse("invalid_message", "missing BeginString");
        }
        if (!SUPPORTED_BEGIN_STRINGS.contains(begin)) {
            return AdaptResult.refuse(
                    "unsupported_begin_string",
                    "BeginString " + begin + " is not FIX.4.2, FIX.4.4, FIX.5.0, or FIXT.1.1");
        }
        Message message;
        DataDictionary sessionDd;
        DataDictionary appDd;
        try {
            sessionDd = sessionDictionary(begin);
            appDd = applicationDictionary(begin);
            message = parseValidated(wire, sessionDd, appDd);
        } catch (ConfigError e) {
            return AdaptResult.refuse("invalid_message", e.getMessage());
        } catch (InvalidMessage e) {
            return classifyParseFailure(e);
        }
        try {
            return mapNewOrderSingle(message, begin, sessionDd, appDd);
        } catch (FieldNotFound e) {
            if (e.field == ClOrdID.FIELD) {
                return AdaptResult.refuse("missing_cl_ord_id", "NewOrderSingle requires ClOrdID (11)");
            }
            if (e.field == OrderQty.FIELD) {
                return AdaptResult.refuse("missing_qty", "NewOrderSingle requires OrderQty (38) as a decimal string");
            }
            if (e.field == Price.FIELD) {
                return AdaptResult.refuse("missing_price", "limit NewOrderSingle requires Price (44) as a decimal string");
            }
            return AdaptResult.refuse("invalid_message", e.getMessage());
        }
    }

    private AdaptResult mapNewOrderSingle(
            Message message, String begin, DataDictionary sessionDd, DataDictionary appDd) throws FieldNotFound {
        String msgType = message.getHeader().getString(MsgType.FIELD);
        if (!MSG_NEW_ORDER_SINGLE.equals(msgType)) {
            return AdaptResult.refuse("unsupported_msg_type", "only NewOrderSingle (35=D) is mapped");
        }
        String applVerId = null;
        if (message.getHeader().isSetField(ApplVerID.FIELD)) {
            applVerId = message.getHeader().getString(ApplVerID.FIELD);
            if (!isSupportedApplVer(begin, applVerId)) {
                return AdaptResult.refuse(
                        "unsupported_appl_ver", "ApplVerID " + applVerId + " is not FIX.5.0");
            }
        } else if (FixVersions.BEGINSTRING_FIXT11.equals(begin)) {
            applVerId = FixVersions.FIX50;
        }
        AdaptResult tagRefuse = refuseUnsupportedTags(message, msgType, sessionDd, appDd);
        if (tagRefuse != null) {
            return tagRefuse;
        }
        AdaptResult economicRefuse = refuseUnmappedEconomic(message);
        if (economicRefuse != null) {
            return economicRefuse;
        }
        if (!message.isSetField(ClOrdID.FIELD)) {
            return AdaptResult.refuse("missing_cl_ord_id", "NewOrderSingle requires ClOrdID (11)");
        }
        String clOrdId = message.getString(ClOrdID.FIELD);
        if (clOrdId.isBlank()) {
            return AdaptResult.refuse("missing_cl_ord_id", "ClOrdID (11) is blank");
        }
        String symbol = message.getString(Symbol.FIELD);
        String side = mapSide(message.getString(Side.FIELD));
        if (side == null) {
            return AdaptResult.refuse("unsupported_side", "Side (54) must be 1=buy or 2=sell");
        }
        String ordTypeWire = message.getString(OrdType.FIELD);
        String ordType = mapOrdType(ordTypeWire);
        if (ordType == null) {
            return AdaptResult.refuse("unsupported_ord_type", "OrdType (40) must be 1=market or 2=limit");
        }
        if (!message.isSetField(OrderQty.FIELD)) {
            return AdaptResult.refuse("missing_qty", "NewOrderSingle requires OrderQty (38) as a decimal string");
        }
        String qty = message.getString(OrderQty.FIELD);
        if (!DECIMAL.matcher(qty).matches()) {
            return AdaptResult.refuse("invalid_decimal", "OrderQty (38) is not a decimal string: " + qty);
        }
        String price = null;
        if (message.isSetField(Price.FIELD)) {
            price = message.getString(Price.FIELD);
            if (!DECIMAL.matcher(price).matches()) {
                return AdaptResult.refuse("invalid_decimal", "Price (44) is not a decimal string: " + price);
            }
        } else if ("limit".equals(ordType)) {
            return AdaptResult.refuse(
                    "missing_price", "limit NewOrderSingle requires Price (44) as a decimal string");
        }
        String senderCompId = null;
        if (message.getHeader().isSetField(SenderCompID.FIELD)) {
            senderCompId = message.getHeader().getString(SenderCompID.FIELD);
        }
        if (senderCompId == null || senderCompId.isBlank()) {
            return AdaptResult.refuse(
                    "matching_account_unmapped",
                    "SenderCompID is blank; svc-fix does not invent an account");
        }
        if (!message.isSetField(TimeInForce.FIELD)) {
            return AdaptResult.refuse("tif_missing", "TimeInForce is missing; svc-fix does not invent GTC");
        }
        String tifWire = message.getString(TimeInForce.FIELD);
        String tif = mapTif(tifWire);
        if (tif == null) {
            return AdaptResult.refuse(
                    "invalid_message",
                    "TimeInForce (59) " + tifWire + " is not DAY/GTC/IOC/FOK/GTD; svc-fix does not invent GTC");
        }
        if ("GTD".equals(tif) && !hasExpire(message)) {
            return AdaptResult.refuse(
                    "gtd_expiry_missing",
                    "TimeInForce GTD requires ExpireTime (126) or ExpireDate (432); svc-fix does not invent an expiry");
        }
        return AdaptResult.command(
                new MatchingOrderCommand(
                        clOrdId, begin, applVerId, symbol, side, ordType, qty, price, senderCompId, tif));
    }

    private static boolean isSupportedApplVer(String begin, String applVerId) {
        if (!FixVersions.BEGINSTRING_FIXT11.equals(begin) && !FixVersions.FIX50.equals(begin)) {
            return true;
        }
        return FixVersions.FIX50.equals(applVerId) || "7".equals(applVerId);
    }

    private static String mapSide(String side) {
        if ("1".equals(side)) {
            return "buy";
        }
        if ("2".equals(side)) {
            return "sell";
        }
        return null;
    }

    private static String mapOrdType(String ordType) {
        if ("1".equals(ordType)) {
            return "market";
        }
        if ("2".equals(ordType)) {
            return "limit";
        }
        return null;
    }

    private static boolean hasExpire(Message message) throws FieldNotFound {
        return present(message, ExpireTime.FIELD) || present(message, ExpireDate.FIELD);
    }

    private static boolean present(Message message, int tag) throws FieldNotFound {
        return message.isSetField(tag) && !message.getString(tag).isBlank();
    }

    /** Dictionary fields the command does not keep. Refuse them; do not drop or invent a quantity. */
    private static AdaptResult refuseUnmappedEconomic(Message message) {
        if (message.isSetField(MinQty.FIELD)) {
            return AdaptResult.refuse(
                    "unmapped_economic_tag",
                    "MinQty (110) is not mapped; svc-fix refuses it rather than dropping or inventing a quantity");
        }
        if (message.isSetField(MaxFloor.FIELD)) {
            return AdaptResult.refuse(
                    "unmapped_economic_tag",
                    "MaxFloor (111) is not mapped; svc-fix refuses it rather than dropping or inventing a quantity");
        }
        return null;
    }

    private static String mapTif(String tif) {
        if ("0".equals(tif)) {
            return "DAY";
        }
        if ("1".equals(tif)) {
            return "GTC";
        }
        if ("3".equals(tif)) {
            return "IOC";
        }
        if ("4".equals(tif)) {
            return "FOK";
        }
        if ("6".equals(tif)) {
            return "GTD";
        }
        return null;
    }

    private static AdaptResult refuseUnsupportedTags(
            Message message, String msgType, DataDictionary sessionDd, DataDictionary appDd) {
        AdaptResult header = refuseUnknown(message.getHeader().iterator(), msgType, sessionDd, appDd, true, false);
        if (header != null) {
            return header;
        }
        AdaptResult body = refuseUnknown(message.iterator(), msgType, sessionDd, appDd, false, false);
        if (body != null) {
            return body;
        }
        return refuseUnknown(message.getTrailer().iterator(), msgType, sessionDd, appDd, false, true);
    }

    private static AdaptResult refuseUnknown(
            Iterator<Field<?>> fields,
            String msgType,
            DataDictionary sessionDd,
            DataDictionary appDd,
            boolean header,
            boolean trailer) {
        while (fields.hasNext()) {
            Field<?> field = fields.next();
            int tag = field.getTag();
            boolean known = header
                    ? sessionDd.isHeaderField(tag) || appDd.isHeaderField(tag)
                    : trailer
                            ? sessionDd.isTrailerField(tag) || appDd.isTrailerField(tag)
                            : appDd.isMsgField(msgType, tag) || sessionDd.isMsgField(msgType, tag);
            if (!known) {
                return AdaptResult.refuse("unsupported_tag", "tag " + tag + " is not in the QuickFIX dictionary");
            }
        }
        return null;
    }

    private static AdaptResult classifyParseFailure(InvalidMessage e) {
        String text = e.getMessage() == null ? "invalid FIX" : e.getMessage();
        String lower = text.toLowerCase();
        if (lower.contains("tag not defined")
                || lower.contains("invalid tag")
                || lower.contains("not defined for this message")
                || lower.contains("unknown") && lower.contains("tag")) {
            return AdaptResult.refuse("unsupported_tag", text);
        }
        if (lower.contains("clordid") || lower.contains("tag=11") || lower.contains("field=11")) {
            return AdaptResult.refuse("missing_cl_ord_id", text);
        }
        return AdaptResult.refuse("invalid_message", text);
    }

    private static Message parseProbe(String wire) throws InvalidMessage {
        Message probe = new Message();
        probe.fromString(wire, null, new ValidationSettings(), false, true);
        return probe;
    }

    private static Message parseValidated(String wire, DataDictionary sessionDd, DataDictionary appDd)
            throws InvalidMessage {
        ValidationSettings settings = new ValidationSettings();
        settings.setAllowUnknownMessageFields(false);
        settings.setCheckUserDefinedFields(true);
        return new Message(wire, sessionDd, appDd, settings, true);
    }

    private DataDictionary sessionDictionary(String begin) throws ConfigError {
        if (FixVersions.BEGINSTRING_FIXT11.equals(begin)) {
            return dictionary("FIXT11.xml");
        }
        return applicationDictionary(begin);
    }

    private DataDictionary applicationDictionary(String begin) throws ConfigError {
        return switch (begin) {
            case FixVersions.BEGINSTRING_FIX42 -> dictionary("FIX42.xml");
            case FixVersions.BEGINSTRING_FIX44 -> dictionary("FIX44.xml");
            case FixVersions.FIX50, FixVersions.BEGINSTRING_FIXT11 -> dictionary("FIX50.xml");
            default -> throw new ConfigError("no dictionary for " + begin);
        };
    }

    private DataDictionary dictionary(String resource) throws ConfigError {
        DataDictionary existing = dictionaries.get(resource);
        if (existing != null) {
            return existing;
        }
        InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(resource);
        if (in == null) {
            in = FixGatewayAdapter.class.getClassLoader().getResourceAsStream(resource);
        }
        if (in == null) {
            throw new ConfigError("QuickFIX DataDictionary missing from classpath: " + resource);
        }
        DataDictionary dd = new DataDictionary(in);
        dictionaries.put(resource, dd);
        return dd;
    }

    static String normalizeSoh(String raw) {
        if (raw.indexOf(SOH) >= 0) {
            return raw;
        }
        return raw.replace('|', SOH);
    }

    static String stripWrappingNewlines(String raw) {
        int start = 0;
        int end = raw.length();
        while (start < end) {
            char c = raw.charAt(start);
            if (c != '\n' && c != '\r' && c != ' ') {
                break;
            }
            start++;
        }
        while (end > start) {
            char c = raw.charAt(end - 1);
            if (c != '\n' && c != '\r' && c != ' ') {
                break;
            }
            end--;
        }
        return raw.substring(start, end);
    }
}
