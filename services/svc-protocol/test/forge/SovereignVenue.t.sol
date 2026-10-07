// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SovereignVenue} from "../../contracts/venue/SovereignVenue.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function startPrank(address) external;
    function stopPrank() external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Token whose decimals can move after the venue is built, and which can keep a transfer fee.
contract VenueMutableToken {
    uint8 public decimals;
    uint256 public feeBps;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setDecimals(uint8 next) external {
        decimals = next;
    }

    function setFeeBps(uint256 next) external {
        require(next < 10_000, "fee");
        feeBps = next;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function slash(address account, uint256 amount) external {
        balanceOf[account] -= amount;
        totalSupply -= amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        return true;
    }
}

/// L342: credit the tokens that arrived, and keep wallet units on the decimals frozen at construction.
contract SovereignVenueReceivedTest {
    uint256 private constant WAD = 1e18;
    uint256 private constant SCALE = 1e12;
    uint256 private constant FEE_BPS = 1_000;
    address private constant BOB = address(0xB0B);

    function test_fee_on_transfer_deposit_credits_tokens_received() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(6);
        base.setFeeBps(FEE_BPS);
        quote.setFeeBps(FEE_BPS);
        SovereignVenue venue = _venue(address(base), address(quote));

        uint256 baseRequest = 1_000 * WAD;
        uint256 quoteRequest = 2_000 * WAD;
        uint256 quoteWallet = quoteRequest / SCALE;
        uint256 baseCredit = _afterFee(baseRequest);
        uint256 quoteCredit = _afterFee(quoteRequest);
        uint256 quoteWalletReceived = _afterFee(quoteWallet);

        _fund(base, quote, address(this), baseRequest, quoteWallet, address(venue));
        _fund(base, quote, BOB, baseRequest, quoteWallet, address(venue));

        venue.deposit(baseRequest, quoteRequest);
        vm.startPrank(BOB);
        venue.deposit(baseRequest, quoteRequest);
        vm.stopPrank();

        require(venue.baseBal(address(this)) == baseCredit, "base credit");
        require(venue.quoteBal(address(this)) == quoteCredit, "quote credit");
        require(venue.baseBal(BOB) == baseCredit, "bob base credit");
        require(venue.quoteBal(BOB) == quoteCredit, "bob quote credit");
        require(base.balanceOf(address(venue)) == baseCredit * 2, "base pool");
        require(quote.balanceOf(address(venue)) == quoteWalletReceived * 2, "quote pool");

        try venue.withdraw(baseRequest, 0) {
            revert("paid the requested base");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SovereignVenue.Insufficient.selector, "over-withdraw reason");
        }
        require(venue.baseBal(address(this)) == baseCredit, "credit unchanged");
        require(base.balanceOf(address(venue)) == baseCredit * 2, "pool unchanged");

        base.setFeeBps(0);
        quote.setFeeBps(0);
        uint256 baseBefore = base.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));
        venue.withdraw(baseCredit, quoteCredit);
        require(base.balanceOf(address(this)) - baseBefore == baseCredit, "base paid received");
        require(quote.balanceOf(address(this)) - quoteBefore == quoteWalletReceived, "quote paid received");
        require(venue.baseBal(address(this)) == 0, "base cleared");
        require(venue.quoteBal(address(this)) == 0, "quote cleared");
        require(base.balanceOf(address(venue)) == baseCredit, "bob base remains");
        require(quote.balanceOf(address(venue)) == quoteWalletReceived, "bob quote remains");

        vm.startPrank(BOB);
        venue.withdraw(baseCredit, quoteCredit);
        vm.stopPrank();
        require(base.balanceOf(address(venue)) == 0, "base empty");
        require(quote.balanceOf(address(venue)) == 0, "quote empty");
        require(venue.baseBal(BOB) == 0, "bob base cleared");
        require(venue.quoteBal(BOB) == 0, "bob quote cleared");
    }

    function test_decimals_change_does_not_rescale_existing_balance() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(6);
        SovereignVenue venue = _venue(address(base), address(quote));

        uint256 baseInternal = 5 * WAD;
        uint256 quoteInternal = 7 * WAD;
        uint256 quoteWallet = quoteInternal / SCALE;
        _fund(base, quote, address(this), baseInternal, quoteWallet, address(venue));
        venue.deposit(baseInternal, quoteInternal);

        require(venue.baseBal(address(this)) == baseInternal, "base booked");
        require(venue.quoteBal(address(this)) == quoteInternal, "quote booked");
        uint256 baseHeld = base.balanceOf(address(venue));
        uint256 quoteHeld = quote.balanceOf(address(venue));
        require(baseHeld == baseInternal, "base wallet held");
        require(quoteHeld == quoteWallet, "quote wallet held");

        base.setDecimals(6);
        quote.setDecimals(18);

        uint256 baseBefore = base.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));
        venue.withdraw(baseInternal, quoteInternal);
        require(base.balanceOf(address(this)) - baseBefore == baseHeld, "base wallet units");
        require(quote.balanceOf(address(this)) - quoteBefore == quoteHeld, "quote wallet units");
        require(base.balanceOf(address(venue)) == 0, "base left in venue");
        require(quote.balanceOf(address(venue)) == 0, "quote left in venue");
        require(venue.baseBal(address(this)) == 0, "base cleared");
        require(venue.quoteBal(address(this)) == 0, "quote cleared");
    }

    function test_plain_18_and_6_decimal_token_deposits_and_withdraws_requested_amount() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(6);
        SovereignVenue venue = _venue(address(base), address(quote));

        uint256 baseInternal = 3 * WAD;
        uint256 quoteInternal = 4 * WAD;
        uint256 quoteWallet = quoteInternal / SCALE;
        _fund(base, quote, address(this), baseInternal, quoteWallet, address(venue));
        venue.deposit(baseInternal, quoteInternal);
        require(venue.baseBal(address(this)) == baseInternal, "base credit");
        require(venue.quoteBal(address(this)) == quoteInternal, "quote credit");

        uint256 baseBefore = base.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));
        venue.withdraw(baseInternal, quoteInternal);
        require(base.balanceOf(address(this)) - baseBefore == baseInternal, "base returned");
        require(quote.balanceOf(address(this)) - quoteBefore == quoteWallet, "quote returned");
        require(venue.baseBal(address(this)) == 0, "base cleared");
        require(venue.quoteBal(address(this)) == 0, "quote cleared");
        require(base.balanceOf(address(venue)) == 0, "base empty");
        require(quote.balanceOf(address(venue)) == 0, "quote empty");
    }

    function test_withdraw_reverts_without_debit_when_token_balance_is_short() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(6);
        SovereignVenue venue = _venue(address(base), address(quote));

        uint256 baseInternal = 100 * WAD;
        uint256 quoteInternal = 100 * WAD;
        uint256 quoteWallet = quoteInternal / SCALE;
        _fund(base, quote, address(this), baseInternal, quoteWallet, address(venue));
        venue.deposit(baseInternal, quoteInternal);
        base.slash(address(venue), 40 * WAD);
        quote.slash(address(venue), 1);

        uint256 baseBook = venue.baseBal(address(this));
        uint256 quoteBook = venue.quoteBal(address(this));
        uint256 baseWallet = base.balanceOf(address(this));
        uint256 quoteWalletBefore = quote.balanceOf(address(this));

        try venue.withdraw(baseInternal, 0) {
            revert("base short paid");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SovereignVenue.Insufficient.selector, "base short reason");
        }
        try venue.withdraw(0, quoteInternal) {
            revert("quote short paid");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SovereignVenue.Insufficient.selector, "quote short reason");
        }

        require(venue.baseBal(address(this)) == baseBook, "base not debited");
        require(venue.quoteBal(address(this)) == quoteBook, "quote not debited");
        require(base.balanceOf(address(this)) == baseWallet, "base not paid");
        require(quote.balanceOf(address(this)) == quoteWalletBefore, "quote not paid");
    }

    function _venue(address base, address quote) internal returns (SovereignVenue) {
        return new SovereignVenue(bytes32(uint256(1)), base, quote, 0, address(0));
    }

    function _fund(
        VenueMutableToken base,
        VenueMutableToken quote,
        address account,
        uint256 baseWallet,
        uint256 quoteWallet,
        address venue
    ) internal {
        base.mint(account, baseWallet);
        quote.mint(account, quoteWallet);
        vm.startPrank(account);
        base.approve(venue, type(uint256).max);
        quote.approve(venue, type(uint256).max);
        vm.stopPrank();
    }

    function _afterFee(uint256 amount) internal pure returns (uint256) {
        return amount - (amount * FEE_BPS) / 10_000;
    }
}

/// L343: a 1-wei remainder priced below 1e18 is zero quote notional. Matching must
/// unlink it and fill the next level. `place` still rejects a new zero-notional order.
contract SovereignVenueDustTest {
    uint256 private constant WAD = 1e18;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);

    function test_one_wei_remainder_below_wad_does_not_block_next_level() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(18);
        SovereignVenue venue = new SovereignVenue(bytes32(uint256(1)), address(base), address(quote), 0, address(0));

        uint256 dustPrice = 1e17;
        uint256 nextPrice = 2e17;
        uint256 dustOrderQty = 10 * WAD + 1;
        uint256 nextQty = 1 * WAD;
        uint256 partialQty = 10 * WAD;
        uint256 partialNotional = (partialQty * dustPrice) / WAD;
        uint256 nextNotional = (nextQty * nextPrice) / WAD;

        _deposit(venue, base, quote, ALICE, dustOrderQty + nextQty, 0);
        vm.startPrank(ALICE);
        uint256 dustId = venue.place(uint8(1), dustPrice, dustOrderQty);
        uint256 nextId = venue.place(uint8(1), nextPrice, nextQty);
        vm.stopPrank();

        _deposit(venue, base, quote, BOB, 0, partialNotional);
        vm.startPrank(BOB);
        require(venue.place(uint8(0), dustPrice, partialQty) == 0, "partial rested");
        vm.stopPrank();

        (,,, uint256 dustLeft,,) = venue.orders(dustId);
        require(dustLeft == 1, "one wei remainder");
        require(venue.bestAsk() == dustPrice, "dust is best ask");
        require(venue.baseBal(BOB) == partialQty, "positive notional fill settled");
        require(venue.quoteBal(ALICE) == partialNotional, "maker received partial quote");

        _deposit(venue, base, quote, CAROL, 0, nextNotional);
        vm.startPrank(CAROL);
        require(venue.place(uint8(0), nextPrice, nextQty) == 0, "next level rested");
        vm.stopPrank();

        (,,, uint256 dustAfter,,) = venue.orders(dustId);
        (,,, uint256 nextAfter,,) = venue.orders(nextId);
        require(dustAfter == 0, "dust unlinked");
        require(nextAfter == 0, "next level filled");
        require(venue.bestAsk() == 0, "ask book clear");
        require(venue.bestBid() == 0, "no bid left resting");
        require(venue.baseBal(CAROL) == nextQty, "taker received next level");
        require(venue.quoteBal(CAROL) == 0, "taker paid next notional");
        require(venue.quoteBal(ALICE) == partialNotional + nextNotional, "maker paid at next price");
        require(venue.baseBal(ALICE) == 1, "dust base stays with maker");
        require(venue.reservedBase(ALICE) == 0, "dust base reserve released");

        vm.startPrank(ALICE);
        try venue.place(uint8(1), dustPrice, 1) {
            revert("placed zero notional");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SovereignVenue.BadAmount.selector, "zero notional reason");
        }
        venue.withdraw(1, 0);
        vm.stopPrank();
        require(venue.baseBal(ALICE) == 0, "dust base withdrawn");
        require(base.balanceOf(ALICE) == 1, "dust base paid out");
    }

    function test_one_wei_bid_remainder_below_wad_does_not_block_next_level() public {
        VenueMutableToken base = new VenueMutableToken(18);
        VenueMutableToken quote = new VenueMutableToken(18);
        SovereignVenue venue = new SovereignVenue(bytes32(uint256(1)), address(base), address(quote), 0, address(0));

        uint256 dustPrice = 2e17;
        uint256 nextPrice = 1e17;
        uint256 dustOrderQty = 5 * WAD + 1;
        uint256 nextQty = 1 * WAD;
        uint256 partialQty = 5 * WAD;
        uint256 partialNotional = (partialQty * dustPrice) / WAD;
        uint256 nextNotional = (nextQty * nextPrice) / WAD;

        _deposit(venue, base, quote, ALICE, 0, partialNotional);
        _deposit(venue, base, quote, BOB, 0, nextNotional);
        vm.startPrank(ALICE);
        uint256 dustId = venue.place(uint8(0), dustPrice, dustOrderQty);
        vm.stopPrank();
        vm.startPrank(BOB);
        uint256 nextId = venue.place(uint8(0), nextPrice, nextQty);
        vm.stopPrank();

        _deposit(venue, base, quote, CAROL, partialQty, 0);
        vm.startPrank(CAROL);
        require(venue.place(uint8(1), dustPrice, partialQty) == 0, "partial rested");
        vm.stopPrank();

        (,,, uint256 dustLeft,,) = venue.orders(dustId);
        require(dustLeft == 1, "one wei bid remainder");
        require(venue.bestBid() == dustPrice, "dust is best bid");
        require(venue.baseBal(ALICE) == partialQty, "positive notional bid fill settled");
        require(venue.quoteBal(CAROL) == partialNotional, "seller received partial quote");

        _deposit(venue, base, quote, address(0xDA7E), nextQty, 0);
        vm.startPrank(address(0xDA7E));
        require(venue.place(uint8(1), nextPrice, nextQty) == 0, "next bid rested");
        vm.stopPrank();

        (,,, uint256 dustAfter,,) = venue.orders(dustId);
        (,,, uint256 nextAfter,,) = venue.orders(nextId);
        require(dustAfter == 0, "dust bid unlinked");
        require(nextAfter == 0, "next bid filled");
        require(venue.bestBid() == 0, "bid book clear");
        require(venue.bestAsk() == 0, "no ask left resting");
        require(venue.baseBal(BOB) == nextQty, "next bidder received base");
        require(venue.quoteBal(address(0xDA7E)) == nextNotional, "seller paid at next bid");
        require(venue.baseBal(ALICE) == partialQty, "dust bid did not take the later base");
        require(venue.reservedQuote(ALICE) == 0, "dust quote reserve clear");
        require(venue.reservedQuote(BOB) == 0, "next bid reserve consumed");
    }

    function _deposit(
        SovereignVenue venue,
        VenueMutableToken base,
        VenueMutableToken quote,
        address account,
        uint256 baseAmount,
        uint256 quoteAmount
    ) internal {
        if (baseAmount > 0) base.mint(account, baseAmount);
        if (quoteAmount > 0) quote.mint(account, quoteAmount);
        vm.startPrank(account);
        base.approve(address(venue), type(uint256).max);
        quote.approve(address(venue), type(uint256).max);
        venue.deposit(baseAmount, quoteAmount);
        vm.stopPrank();
    }
}
