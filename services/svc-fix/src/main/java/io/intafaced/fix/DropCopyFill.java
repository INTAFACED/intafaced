package io.intafaced.fix;

import java.util.regex.Pattern;

/**
 * House-book fill on the drop-copy ingest wire. Local JSON — not packages/events.
 * Money fields are decimal strings. Sequence is a book counter, not money.
 * ExecID is fillId or sequence already on the payload. Never a UUID minted here.
 */
public final class DropCopyFill {
    private static final Pattern DECIMAL = Pattern.compile("^\\d+(\\.\\d{1,18})?$");
    private static final String[] MONEY_KEYS = {"price", "qty", "quoteAmount", "feeAmount"};

    public final String fillId;
    public final String orderId;
    public final String userId;
    public final String marketId;
    public final String side;
    public final String price;
    public final String qty;
    public final String quoteAmount;
    public final String feeAsset;
    public final String feeAmount;
    public final Long sequence;
    public final String ts;
    public final String source;

    DropCopyFill(
            String fillId,
            String orderId,
            String userId,
            String marketId,
            String side,
            String price,
            String qty,
            String quoteAmount,
            String feeAsset,
            String feeAmount,
            Long sequence,
            String ts,
            String source) {
        this.fillId = fillId;
        this.orderId = orderId;
        this.userId = userId;
        this.marketId = marketId;
        this.side = side;
        this.price = price;
        this.qty = qty;
        this.quoteAmount = quoteAmount;
        this.feeAsset = feeAsset;
        this.feeAmount = feeAmount;
        this.sequence = sequence;
        this.ts = ts;
        this.source = source;
    }

    /** fillId if present, else sequence. Never a generated UUID. */
    public String execId() {
        if (fillId != null && !fillId.isBlank()) {
            return fillId;
        }
        if (sequence != null) {
            return Long.toString(sequence);
        }
        return null;
    }

    public static ParseResult parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return ParseResult.refuse(
                    "dropcopy_execution_missing", "execution is missing; svc-fix does not synthesize a drop-copy fill");
        }
        String json = raw.trim();
        if (!json.startsWith("{") || !json.endsWith("}")) {
            return ParseResult.refuse(
                    "dropcopy_execution_missing", "execution is missing; svc-fix does not synthesize a drop-copy fill");
        }
        for (String money : MONEY_KEYS) {
            Field field = readField(json, money);
            if (field != null && field.kind == Field.Kind.NUMBER) {
                return ParseResult.refuse(
                        "invalid_decimal", money + " is a JSON number; drop-copy money is a decimal string");
            }
            if (field != null && field.kind == Field.Kind.STRING && !DECIMAL.matcher(field.value).matches()) {
                return ParseResult.refuse(
                        "invalid_decimal", money + " must be an explicit decimal string; svc-fix does not treat IEEE as money");
            }
            if (("price".equals(money) || "qty".equals(money))
                    && field != null
                    && field.kind != Field.Kind.NULL
                    && field.kind != Field.Kind.STRING) {
                return ParseResult.refuse(
                        "invalid_decimal",
                        money + " must be an explicit decimal string; svc-fix does not treat IEEE as money");
            }
        }
        String fillId = readString(json, "fillId");
        String orderId = readString(json, "orderId");
        String userId = readString(json, "userId");
        String marketId = readString(json, "marketId");
        String side = readString(json, "side");
        String price = readString(json, "price");
        String qty = readString(json, "qty");
        String quoteAmount = readString(json, "quoteAmount");
        String feeAsset = readString(json, "feeAsset");
        String feeAmount = readString(json, "feeAmount");
        String ts = readString(json, "ts");
        String source = readString(json, "source");
        Long sequence;
        try {
            sequence = readInteger(json, "sequence");
        } catch (IllegalArgumentException e) {
            return ParseResult.refuse("dropcopy_execution_missing", e.getMessage());
        }
        if (source == null || source.isBlank()) {
            return ParseResult.refuse(
                    "dropcopy_source_missing",
                    "source is missing; svc-fix does not synthesize missing sources");
        }
        if (side != null && !"buy".equals(side) && !"sell".equals(side) && !"1".equals(side) && !"2".equals(side)) {
            return ParseResult.refuse(
                    "dropcopy_execution_missing", "side is not buy or sell; svc-fix does not invent a side");
        }
        DropCopyFill fill = new DropCopyFill(
                fillId,
                orderId,
                userId,
                marketId,
                side,
                price,
                qty,
                quoteAmount,
                feeAsset,
                feeAmount,
                sequence,
                ts,
                source);
        if (fill.execId() == null) {
            return ParseResult.refuse(
                    "dropcopy_execution_missing",
                    "fillId and sequence are missing; svc-fix does not invent ExecID");
        }
        if (price == null) {
            return ParseResult.refuse(
                    "dropcopy_price_missing", "price is missing; svc-fix does not invent a fill price");
        }
        if (qty == null) {
            return ParseResult.refuse(
                    "dropcopy_qty_missing", "qty is missing; svc-fix does not invent a fill quantity");
        }
        return ParseResult.ok(fill);
    }

    public static final class ParseResult {
        public final boolean ok;
        public final DropCopyFill fill;
        public final String errorCode;
        public final String errorMessage;

        private ParseResult(boolean ok, DropCopyFill fill, String errorCode, String errorMessage) {
            this.ok = ok;
            this.fill = fill;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static ParseResult ok(DropCopyFill fill) {
            return new ParseResult(true, fill, null, null);
        }

        static ParseResult refuse(String code, String message) {
            return new ParseResult(false, null, code, message);
        }
    }

    private static final class Field {
        enum Kind {
            STRING,
            NUMBER,
            NULL,
            OTHER
        }

        final Kind kind;
        final String value;

        Field(Kind kind, String value) {
            this.kind = kind;
            this.value = value;
        }
    }

    private static String readString(String json, String key) {
        Field field = readField(json, key);
        if (field == null || field.kind != Field.Kind.STRING) {
            return null;
        }
        return field.value;
    }

    private static Long readInteger(String json, String key) {
        Field field = readField(json, key);
        if (field == null || field.kind == Field.Kind.NULL) {
            return null;
        }
        String text = field.value;
        if (field.kind == Field.Kind.STRING) {
            text = field.value;
        } else if (field.kind != Field.Kind.NUMBER) {
            throw new IllegalArgumentException("sequence is not an integer; svc-fix does not invent ExecID");
        }
        if (text == null || text.isBlank()) {
            return null;
        }
        if (!text.matches("^-?\\d+$")) {
            throw new IllegalArgumentException("sequence is not an integer; svc-fix does not invent ExecID");
        }
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("sequence is not an integer; svc-fix does not invent ExecID");
        }
    }

    private static Field readField(String json, String key) {
        String needle = "\"" + key + "\"";
        int i = 0;
        while (i < json.length()) {
            int at = json.indexOf(needle, i);
            if (at < 0) {
                return null;
            }
            int colon = at + needle.length();
            while (colon < json.length() && Character.isWhitespace(json.charAt(colon))) {
                colon++;
            }
            if (colon >= json.length() || json.charAt(colon) != ':') {
                i = at + 1;
                continue;
            }
            int v = colon + 1;
            while (v < json.length() && Character.isWhitespace(json.charAt(v))) {
                v++;
            }
            if (v >= json.length()) {
                return null;
            }
            if (json.startsWith("null", v) && endOfLiteral(json, v + 4)) {
                return new Field(Field.Kind.NULL, null);
            }
            char c = json.charAt(v);
            if (c == '"') {
                return new Field(Field.Kind.STRING, readQuoted(json, v + 1));
            }
            if (c == '-' || c == '+' || Character.isDigit(c)) {
                int end = v;
                if (json.charAt(end) == '+' || json.charAt(end) == '-') {
                    end++;
                }
                while (end < json.length()
                        && (Character.isDigit(json.charAt(end))
                                || json.charAt(end) == '.'
                                || json.charAt(end) == 'e'
                                || json.charAt(end) == 'E'
                                || json.charAt(end) == '+'
                                || json.charAt(end) == '-')) {
                    end++;
                }
                return new Field(Field.Kind.NUMBER, json.substring(v, end));
            }
            return new Field(Field.Kind.OTHER, null);
        }
        return null;
    }

    private static boolean endOfLiteral(String json, int i) {
        if (i >= json.length()) {
            return true;
        }
        char c = json.charAt(i);
        return c == ',' || c == '}' || Character.isWhitespace(c);
    }

    private static String readQuoted(String json, int start) {
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '"') {
                return sb.toString();
            }
            if (c == '\\' && i + 1 < json.length()) {
                char n = json.charAt(i + 1);
                switch (n) {
                    case '"', '\\', '/' -> sb.append(n);
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    default -> sb.append(n);
                }
                i++;
                continue;
            }
            sb.append(c);
        }
        return sb.toString();
    }
}
