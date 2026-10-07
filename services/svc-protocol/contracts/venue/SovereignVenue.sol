// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * SOVEREIGN VENUE — Protocol Plane (board S-C1 / `socket.clob-contracts`).
 *
 * THIS IS A REAL BOOK. It is not `DevVenue`. Fills emit only from matching.
 * There is no `recordFill` / `publishLevel`. There is no platform operator,
 * pause, or guardian. `audited` stays false until an external audit (Nitro).
 *
 * One market per deployment. Book / events / place qty are `uint256` WAD
 * (18 implied decimals — indexer ABI + ledger-client Amount). Wallet
 * transfers scale with the decimals frozen at construction: 18-dec tokens 1:1,
 * 6-dec (USDC) ÷ 1e12. A later `decimals()` change does not rescale a balance.
 * Any other `decimals()` reverts `BadDecimals`. Deposit credits the token
 * balance increase, converted with those frozen decimals.
 *
 * Event surface = indexer surface (`svc-indexer` `src/chain/evm/abi.ts`):
 *   BookLevel(bytes32 indexed market, uint8 side, uint256 price, uint256 quantity)
 *   Fill(bytes32 indexed market, address indexed maker, address indexed taker,
 *        uint256 price, uint256 quantity, uint8 takerSide)
 *   Position(bytes32 indexed market, address indexed account, int256 size, uint256 entryPrice)
 *
 * BookLevel `quantity` is ABSOLUTE resting at that price (`0` = empty).
 * `takerSide` 0 = buy, 1 = sell. `side` 0 = bid, 1 = ask.
 *
 * Fee: immutable taker bps taken from quote notional on each fill. Settlement
 * cost in quote asset is 0 — the user already pays gas on the matching tx;
 * this venue does not add a second quote-asset settlement charge.
 */
contract SovereignVenue {
    uint8 public constant SIDE_BID = 0;
    uint8 public constant SIDE_ASK = 1;
    uint8 public constant TAKER_BUY = 0;
    uint8 public constant TAKER_SELL = 1;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant USDC_SCALE = 1e12;

    bytes32 public immutable marketId;
    address public immutable baseToken;
    address public immutable quoteToken;
    uint16 public immutable takerFeeBps;
    address public immutable feeRecipient;
    uint8 private immutable baseDecimals;
    uint8 private immutable quoteDecimals;

    uint256 public nextOrderId = 1;
    uint256 public bestBid;
    uint256 public bestAsk;

    struct Order {
        address trader;
        uint8 side;
        uint256 price;
        uint256 remaining;
        uint256 prev;
        uint256 next;
    }

    mapping(uint256 => Order) public orders;
    mapping(uint8 => mapping(uint256 => uint256)) public qtyAt;
    mapping(uint8 => mapping(uint256 => uint256)) public headAt;
    mapping(uint8 => mapping(uint256 => uint256)) public tailAt;
    mapping(uint8 => mapping(uint256 => uint256)) public worsePrice;
    mapping(uint8 => mapping(uint256 => uint256)) public betterPrice;

    mapping(address => uint256) public baseBal;
    mapping(address => uint256) public quoteBal;
    mapping(address => uint256) public reservedBase;
    mapping(address => uint256) public reservedQuote;

    mapping(address => int256) public positionSize;
    mapping(address => uint256) public positionEntry;

    event BookLevel(bytes32 indexed market, uint8 side, uint256 price, uint256 quantity);
    event Fill(
        bytes32 indexed market,
        address indexed maker,
        address indexed taker,
        uint256 price,
        uint256 quantity,
        uint8 takerSide
    );
    event Position(bytes32 indexed market, address indexed account, int256 size, uint256 entryPrice);
    event Deposited(address indexed account, uint256 baseAmount, uint256 quoteAmount);
    event Withdrawn(address indexed account, uint256 baseAmount, uint256 quoteAmount);

    error BadConfig();
    error BadAmount();
    error BadDecimals();
    error Overflow();
    error TransferFailed();
    error Insufficient();
    error NotTrader();
    error SelfTrade();

    constructor(
        bytes32 marketId_,
        address baseToken_,
        address quoteToken_,
        uint16 takerFeeBps_,
        address feeRecipient_
    ) {
        if (baseToken_ == address(0) || quoteToken_ == address(0) || baseToken_ == quoteToken_) revert BadConfig();
        if (marketId_ == bytes32(0)) revert BadConfig();
        if (takerFeeBps_ > 1_000) revert BadConfig();
        if (takerFeeBps_ > 0 && feeRecipient_ == address(0)) revert BadConfig();
        if (feeRecipient_ == address(this)) revert BadConfig();
        marketId = marketId_;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        takerFeeBps = takerFeeBps_;
        feeRecipient = feeRecipient_;
        baseDecimals = _decimalsOf(baseToken_);
        quoteDecimals = _decimalsOf(quoteToken_);
    }

    /** Decimals observed once. Later `decimals()` changes do not rescale a balance. */
    function _decimalsOf(address token) internal view returns (uint8 d) {
        d = IERC20Minimal(token).decimals();
        if (d != 18 && d != 6) revert BadDecimals();
    }

    /** Quote-asset settlement surcharge. Always 0: gas is the user's tx. */
    function settlementCostQuote() external pure returns (uint256) {
        return 0;
    }

    function deposit(uint256 baseAmount, uint256 quoteAmount) external {
        if (baseAmount == 0 && quoteAmount == 0) revert BadAmount();
        uint256 creditedBase;
        uint256 creditedQuote;
        if (baseAmount > 0) {
            creditedBase = _pull(baseToken, baseDecimals, baseAmount);
            baseBal[msg.sender] += creditedBase;
        }
        if (quoteAmount > 0) {
            creditedQuote = _pull(quoteToken, quoteDecimals, quoteAmount);
            quoteBal[msg.sender] += creditedQuote;
        }
        emit Deposited(msg.sender, creditedBase, creditedQuote);
    }

    function withdraw(uint256 baseAmount, uint256 quoteAmount) external {
        if (baseAmount == 0 && quoteAmount == 0) revert BadAmount();
        if (baseAmount > 0) {
            if (baseBal[msg.sender] - reservedBase[msg.sender] < baseAmount) revert Insufficient();
            uint256 pushed = _toWallet(baseDecimals, baseAmount);
            if (IERC20Minimal(baseToken).balanceOf(address(this)) < pushed) revert Insufficient();
            baseBal[msg.sender] -= baseAmount;
            if (!IERC20Minimal(baseToken).transfer(msg.sender, pushed)) revert TransferFailed();
        }
        if (quoteAmount > 0) {
            if (quoteBal[msg.sender] - reservedQuote[msg.sender] < quoteAmount) revert Insufficient();
            uint256 pushed = _toWallet(quoteDecimals, quoteAmount);
            if (IERC20Minimal(quoteToken).balanceOf(address(this)) < pushed) revert Insufficient();
            quoteBal[msg.sender] -= quoteAmount;
            if (!IERC20Minimal(quoteToken).transfer(msg.sender, pushed)) revert TransferFailed();
        }
        emit Withdrawn(msg.sender, baseAmount, quoteAmount);
    }

    /**
     * Pull the wallet units for `internalAmount` and return the internal credit
     * matching the token balance increase. A short delivery credits what arrived.
     */
    function _pull(address token, uint8 d, uint256 internalAmount) internal returns (uint256 credited) {
        uint256 requested = _toWallet(d, internalAmount);
        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), requested)) revert TransferFailed();
        uint256 afterBal = IERC20Minimal(token).balanceOf(address(this));
        if (afterBal < beforeBal) revert TransferFailed();
        credited = _fromWallet(d, afterBal - beforeBal);
    }

    /** Internal WAD → wallet units. Frozen 18-dec is 1:1; frozen 6-dec ÷ 1e12 (must divide evenly). */
    function _toWallet(uint8 d, uint256 internalAmount) internal pure returns (uint256) {
        if (d == 18) return internalAmount;
        if (d == 6) {
            if (internalAmount % USDC_SCALE != 0) revert BadAmount();
            return internalAmount / USDC_SCALE;
        }
        revert BadDecimals();
    }

    /** Wallet units → internal WAD, using the decimals frozen at construction. */
    function _fromWallet(uint8 d, uint256 walletAmount) internal pure returns (uint256) {
        if (d == 18) return walletAmount;
        if (d == 6) {
            if (walletAmount > type(uint256).max / USDC_SCALE) revert Overflow();
            return walletAmount * USDC_SCALE;
        }
        revert BadDecimals();
    }

    /**
     * Limit order: match first, rest the remainder. `side` 0 = bid (buy base),
     * 1 = ask (sell base). Price-time priority. Maker price is the fill price.
     */
    function place(uint8 side, uint256 price, uint256 quantity) external returns (uint256 orderId) {
        if (side > SIDE_ASK || price == 0 || quantity == 0) revert BadAmount();
        if (_quoteAmount(quantity, price) == 0) revert BadAmount();

        uint8 takerSide = side == SIDE_BID ? TAKER_BUY : TAKER_SELL;
        uint256 remaining = _match(msg.sender, takerSide, price, quantity);
        if (remaining == 0) return 0;
        if (_quoteAmount(remaining, price) == 0) return 0;

        if (side == SIDE_ASK) {
            if (baseBal[msg.sender] - reservedBase[msg.sender] < remaining) revert Insufficient();
        } else if (quoteBal[msg.sender] - reservedQuote[msg.sender] < _quoteAmount(remaining, price)) {
            revert Insufficient();
        }

        orderId = nextOrderId++;
        uint256 prev = tailAt[side][price];
        orders[orderId] = Order({
            trader: msg.sender,
            side: side,
            price: price,
            remaining: remaining,
            prev: prev,
            next: 0
        });
        if (headAt[side][price] == 0) {
            headAt[side][price] = orderId;
            _insertLevel(side, price);
        } else {
            orders[prev].next = orderId;
        }
        tailAt[side][price] = orderId;
        qtyAt[side][price] += remaining;
        if (side == SIDE_ASK) reservedBase[msg.sender] += remaining;
        else reservedQuote[msg.sender] += _quoteAmount(remaining, price);
        emit BookLevel(marketId, side, price, qtyAt[side][price]);
    }

    function cancel(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.trader != msg.sender) revert NotTrader();
        uint256 qty = o.remaining;
        if (qty == 0) revert BadAmount();
        uint8 side = o.side;
        uint256 price = o.price;
        _unlink(orderId);
        o.remaining = 0;
        qtyAt[side][price] -= qty;
        if (side == SIDE_ASK) reservedBase[msg.sender] -= qty;
        else reservedQuote[msg.sender] -= _quoteAmount(qty, price);
        emit BookLevel(marketId, side, price, qtyAt[side][price]);
        if (qtyAt[side][price] == 0) _removeLevel(side, price);
    }

    function _match(address taker, uint8 takerSide, uint256 limitPrice, uint256 quantity) internal returns (uint256 remaining) {
        remaining = quantity;
        while (remaining > 0) {
            uint256 nextRemaining = _takeBest(taker, takerSide, limitPrice, remaining);
            if (nextRemaining == remaining) break;
            remaining = nextRemaining;
        }
    }

    function _takeBest(address taker, uint8 takerSide, uint256 limitPrice, uint256 remaining) internal returns (uint256 leftover) {
        uint8 makerSide = takerSide == TAKER_BUY ? SIDE_ASK : SIDE_BID;
        while (true) {
            uint256 px = makerSide == SIDE_ASK ? bestAsk : bestBid;
            if (px == 0) return remaining;
            if (takerSide == TAKER_BUY && px > limitPrice) return remaining;
            if (takerSide == TAKER_SELL && px < limitPrice) return remaining;
            uint256 oid = headAt[makerSide][px];
            if (oid == 0) {
                _removeLevel(makerSide, px);
                continue;
            }
            // A partial fill can leave a remainder whose quote notional is zero.
            // That dust is not the end of the book: unlink it and walk on.
            if (_quoteAmount(orders[oid].remaining, px) == 0) {
                _discardDust(oid, makerSide, px);
                continue;
            }
            address maker = orders[oid].trader;
            if (maker == taker) revert SelfTrade();
            uint256 fillQty = remaining < orders[oid].remaining ? remaining : orders[oid].remaining;
            uint256 notional = _quoteAmount(fillQty, px);
            if (notional == 0) return remaining;
            _settle(taker, maker, takerSide, fillQty, notional, (notional * uint256(takerFeeBps)) / BPS);
            remaining -= fillQty;
            orders[oid].remaining -= fillQty;
            qtyAt[makerSide][px] -= fillQty;
            if (orders[oid].remaining == 0) _unlink(oid);
            emit Fill(marketId, maker, taker, px, fillQty, takerSide);
            emit BookLevel(marketId, makerSide, px, qtyAt[makerSide][px]);
            _applyPos(maker, makerSide == SIDE_ASK ? -int256(fillQty) : int256(fillQty), px);
            _applyPos(taker, takerSide == TAKER_BUY ? int256(fillQty) : -int256(fillQty), px);
            if (qtyAt[makerSide][px] == 0) _removeLevel(makerSide, px);
            return remaining;
        }
    }

    function _settle(
        address taker,
        address maker,
        uint8 takerSide,
        uint256 fillQty,
        uint256 notional,
        uint256 fee
    ) internal {
        if (takerSide == TAKER_BUY) {
            uint256 cost = notional + fee;
            if (quoteBal[taker] - reservedQuote[taker] < cost) revert Insufficient();
            quoteBal[taker] -= cost;
            reservedBase[maker] -= fillQty;
            baseBal[maker] -= fillQty;
            quoteBal[maker] += notional;
            baseBal[taker] += fillQty;
        } else {
            if (baseBal[taker] - reservedBase[taker] < fillQty) revert Insufficient();
            if (notional < fee) revert Insufficient();
            baseBal[taker] -= fillQty;
            reservedQuote[maker] -= notional;
            quoteBal[maker] -= notional;
            baseBal[maker] += fillQty;
            quoteBal[taker] += notional - fee;
        }
        if (fee > 0) quoteBal[feeRecipient] += fee;
    }

    function _applyPos(address account, int256 delta, uint256 price) internal {
        int256 s = positionSize[account];
        int256 n = s + delta;
        if (n == 0) {
            positionSize[account] = 0;
            positionEntry[account] = 0;
        } else if (s == 0 || (s > 0 && delta > 0) || (s < 0 && delta < 0)) {
            uint256 absS = _abs(s);
            uint256 absD = _abs(delta);
            positionEntry[account] = (absS * positionEntry[account] + absD * price) / (absS + absD);
            positionSize[account] = n;
        } else if ((s > 0 && n > 0) || (s < 0 && n < 0)) {
            positionSize[account] = n;
        } else {
            positionEntry[account] = price;
            positionSize[account] = n;
        }
        emit Position(marketId, account, positionSize[account], positionEntry[account]);
    }

    function _insertLevel(uint8 side, uint256 price) internal {
        if (side == SIDE_BID) {
            if (bestBid == 0 || price > bestBid) {
                worsePrice[side][price] = bestBid;
                if (bestBid != 0) betterPrice[side][bestBid] = price;
                bestBid = price;
                return;
            }
            uint256 cur = bestBid;
            while (true) {
                uint256 nxt = worsePrice[side][cur];
                if (nxt == 0 || price > nxt) {
                    worsePrice[side][cur] = price;
                    betterPrice[side][price] = cur;
                    worsePrice[side][price] = nxt;
                    if (nxt != 0) betterPrice[side][nxt] = price;
                    return;
                }
                if (nxt == price) return;
                cur = nxt;
            }
        }
        if (bestAsk == 0 || price < bestAsk) {
            worsePrice[side][price] = bestAsk;
            if (bestAsk != 0) betterPrice[side][bestAsk] = price;
            bestAsk = price;
            return;
        }
        uint256 curAsk = bestAsk;
        while (true) {
            uint256 nxtAsk = worsePrice[side][curAsk];
            if (nxtAsk == 0 || price < nxtAsk) {
                worsePrice[side][curAsk] = price;
                betterPrice[side][price] = curAsk;
                worsePrice[side][price] = nxtAsk;
                if (nxtAsk != 0) betterPrice[side][nxtAsk] = price;
                return;
            }
            if (nxtAsk == price) return;
            curAsk = nxtAsk;
        }
    }

    function _removeLevel(uint8 side, uint256 price) internal {
        uint256 prev = betterPrice[side][price];
        uint256 nxt = worsePrice[side][price];
        if (side == SIDE_BID) {
            if (bestBid == price) bestBid = nxt;
        } else if (bestAsk == price) {
            bestAsk = nxt;
        }
        if (prev != 0) worsePrice[side][prev] = nxt;
        if (nxt != 0) betterPrice[side][nxt] = prev;
        delete worsePrice[side][price];
        delete betterPrice[side][price];
        delete headAt[side][price];
        delete tailAt[side][price];
    }

    /// Remove a resting order that can no longer settle quote, and free its reserve.
    function _discardDust(uint256 orderId, uint8 side, uint256 price) internal {
        Order storage o = orders[orderId];
        uint256 qty = o.remaining;
        address trader = o.trader;
        _unlink(orderId);
        o.remaining = 0;
        qtyAt[side][price] -= qty;
        if (side == SIDE_ASK) reservedBase[trader] -= qty;
        else reservedQuote[trader] -= _quoteAmount(qty, price);
        emit BookLevel(marketId, side, price, qtyAt[side][price]);
        if (qtyAt[side][price] == 0) _removeLevel(side, price);
    }

    function _unlink(uint256 orderId) internal {
        Order storage o = orders[orderId];
        uint8 side = o.side;
        uint256 price = o.price;
        if (o.prev != 0) orders[o.prev].next = o.next;
        else headAt[side][price] = o.next;
        if (o.next != 0) orders[o.next].prev = o.prev;
        else tailAt[side][price] = o.prev;
        o.prev = 0;
        o.next = 0;
    }

    function _quoteAmount(uint256 qty, uint256 price) internal pure returns (uint256) {
        if (price != 0 && qty > type(uint256).max / price) revert Overflow();
        return (qty * price) / WAD;
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v >= 0 ? uint256(v) : uint256(-v);
    }
}
