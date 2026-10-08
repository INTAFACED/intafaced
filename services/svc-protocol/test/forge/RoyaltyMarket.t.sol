// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoyaltyMarket} from "../../contracts/nft/RoyaltyMarket.sol";
import {SovereignNft} from "../../contracts/nft/SovereignNft.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Quote that can deliver a different amount than the caller asked to transfer in.
contract ShortQuote {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// Units withheld from the recipient on `transferFrom`. Outbound `transfer` is exact.
    uint256 public withhold;
    /// Extra units credited to the recipient on `transferFrom`, on top of `amount`.
    uint256 public bonus;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setWithhold(uint256 withhold_) external {
        withhold = withhold_;
    }

    function setBonus(uint256 bonus_) external {
        bonus = bonus_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 credit = amount + bonus;
        if (withhold >= credit) credit = 0;
        else credit -= withhold;
        balanceOf[to] += credit;
        return true;
    }
}

contract RoyaltyMarketForgeTest {
    RoyaltyMarket internal market;
    SovereignNft internal nft;
    ShortQuote internal quote;

    address internal seller = address(0xA11CE);
    address internal bidder = address(0xB1D);
    address internal otherBidder = address(0xB2D);
    address internal buyer = address(0xB0B);
    address internal royaltyTo = address(0xE01A);

    uint32 internal constant DAY = 1 days;

    function setUp() public {
        market = new RoyaltyMarket();
        nft = new SovereignNft("Sovereign", "SOV");
        quote = new ShortQuote();
    }

    function test_unsolicited_safeTransfer_reverts_and_expected_delivery_cancels() public {
        SovereignNft fresh = new SovereignNft("Sovereign", "SOV");
        RoyaltyMarket freshMarket = new RoyaltyMarket();
        uint256 unexpectedId = fresh.mint(address(this));
        uint256 askedId = fresh.mint(address(this));

        try fresh.safeTransferFrom(address(this), address(freshMarket), unexpectedId) {
            revert("unsolicited");
        } catch {}
        require(fresh.ownerOf(unexpectedId) == address(this), "sender keeps the NFT");
        require(freshMarket.escrowedFrom(address(fresh), unexpectedId) == address(0), "unsolicited recorded nothing");

        fresh.approve(address(freshMarket), askedId);
        uint256 id = freshMarket.list(address(fresh), askedId, address(0xC0DE), 1);
        require(fresh.ownerOf(askedId) == address(freshMarket), "market holds the asked NFT");
        require(freshMarket.escrowedFrom(address(fresh), askedId) == address(this), "escrow recorded");
        (address recordedSeller, , , , , bool active) = freshMarket.listings(id);
        require(recordedSeller == address(this) && active, "listing records the seller");

        freshMarket.cancel(id);
        require(fresh.ownerOf(askedId) == address(this), "cancel returns it");
        require(fresh.ownerOf(unexpectedId) == address(this), "unsolicited still with sender");
        require(freshMarket.escrowedFrom(address(fresh), askedId) == address(0), "escrow cleared");
        require(fresh.balanceOf(address(freshMarket)) == 0, "market holds nothing");
    }

    function test_short_bid_reverts_and_does_not_spend_other_auction_escrow() public {
        uint256 funded = _startAuction(0);
        _bid(funded, bidder, 1_000);
        require(quote.balanceOf(address(market)) == 1_000, "funded escrow");

        uint256 other = _startAuction(0);
        quote.setWithhold(400);
        quote.mint(otherBidder, 1_000);
        vm.prank(otherBidder);
        quote.approve(address(market), 1_000);

        vm.prank(otherBidder);
        vm.expectRevert(RoyaltyMarket.PaymentTooLow.selector);
        market.bid(other, 1_000);

        (address winner, uint256 high) = _high(other);
        require(winner == address(0) && high == 0, "short bid is not winning");
        (address fundedWinner, uint256 fundedBid) = _high(funded);
        require(fundedWinner == bidder && fundedBid == 1_000, "funded bid stays credited");
        require(quote.balanceOf(address(market)) == 1_000, "other escrow untouched");
        require(quote.balanceOf(otherBidder) == 1_000, "short bidder kept their quote");

        vm.warp(block.timestamp + DAY + 1);
        market.endAuction(funded);
        require(quote.balanceOf(seller) == 1_000, "funded seller paid from that bid");
        require(quote.balanceOf(address(market)) == 0, "no shared remainder");
        require(nft.ownerOf(_tokenOfAuction(funded)) == bidder, "winner receives nft");
    }

    function test_zero_receipt_bid_reverts_before_it_is_the_winning_bid() public {
        uint256 id = _startAuction(0);
        quote.setWithhold(500);
        quote.mint(bidder, 500);
        vm.prank(bidder);
        quote.approve(address(market), 500);

        vm.prank(bidder);
        vm.expectRevert(RoyaltyMarket.PaymentTooLow.selector);
        market.bid(id, 500);

        (address winner, uint256 high) = _high(id);
        require(winner == address(0) && high == 0, "zero receipt not booked");
        require(quote.balanceOf(address(market)) == 0, "market holds nothing");
    }

    function test_short_buy_reverts_and_leaves_auction_escrow() public {
        uint256 funded = _startAuction(0);
        _bid(funded, bidder, 1_000);

        uint256 listingId = _list(800);
        quote.setWithhold(100);
        quote.mint(buyer, 800);
        vm.prank(buyer);
        quote.approve(address(market), 800);

        vm.prank(buyer);
        vm.expectRevert(RoyaltyMarket.PaymentTooLow.selector);
        market.buy(listingId);

        require(_listingActive(listingId), "listing still for sale");
        require(quote.balanceOf(address(market)) == 1_000, "auction escrow intact");
        require(quote.balanceOf(buyer) == 800, "buyer not charged");
        require(nft.ownerOf(_tokenOfListing(listingId)) == address(market), "nft stays escrowed");
    }

    function test_full_delivery_credits_that_amount_and_refunds_the_prior_credit() public {
        uint256 sibling = _startAuction(0);
        _bid(sibling, bidder, 2_000);

        uint256 id = _startAuctionWithRoyalty(500);
        _bid(id, otherBidder, 400);

        quote.mint(buyer, 900);
        vm.prank(buyer);
        quote.approve(address(market), 900);
        uint256 prior = quote.balanceOf(otherBidder);
        vm.prank(buyer);
        market.bid(id, 900);

        require(quote.balanceOf(otherBidder) == prior + 400, "refund is the credited bid");
        (address winner, uint256 high) = _high(id);
        require(winner == buyer && high == 900, "full amount credited");
        require(quote.balanceOf(address(market)) == 2_900, "sibling escrow still held");

        vm.warp(block.timestamp + DAY + 1);
        market.endAuction(id);
        require(quote.balanceOf(royaltyTo) == 45, "royalty from the credited bid");
        require(quote.balanceOf(seller) == 855, "seller remainder of the credited bid");
        require(quote.balanceOf(address(market)) == 2_000, "sibling escrow not spent");
        require(nft.ownerOf(_tokenOfAuction(id)) == buyer, "high bidder receives nft");
    }

    function test_surplus_receipt_is_the_credited_bid_and_the_refund() public {
        uint256 id = _startAuction(0);
        quote.setBonus(50);

        quote.mint(bidder, 200);
        vm.prank(bidder);
        quote.approve(address(market), 200);
        vm.prank(bidder);
        market.bid(id, 200);
        (address first, uint256 firstBid) = _high(id);
        require(first == bidder && firstBid == 250, "credit the balance increase");
        require(quote.balanceOf(address(market)) == 250, "market holds the increase");

        quote.mint(otherBidder, 300);
        vm.prank(otherBidder);
        quote.approve(address(market), 300);
        vm.prank(otherBidder);
        market.bid(id, 300);

        require(quote.balanceOf(bidder) == 250, "previous bidder refunded the credit");
        (address winner, uint256 high) = _high(id);
        require(winner == otherBidder && high == 350, "new credit is the increase");
        require(quote.balanceOf(address(market)) == 350, "only the new credit remains");

        vm.warp(block.timestamp + DAY + 1);
        market.endAuction(id);
        require(quote.balanceOf(seller) == 350, "payout is the held credit");
        require(quote.balanceOf(address(market)) == 0, "nothing left to share");
    }

    function _startAuction(uint256 minBid) internal returns (uint256 id) {
        uint256 tokenId = _mintApproved();
        vm.prank(seller);
        id = market.startAuction(address(nft), tokenId, address(quote), minBid, DAY);
    }

    function _startAuctionWithRoyalty(uint16 bps) internal returns (uint256 id) {
        uint256 tokenId = _mintApproved();
        vm.prank(seller);
        nft.setTokenRoyalty(tokenId, royaltyTo, bps);
        vm.prank(seller);
        id = market.startAuction(address(nft), tokenId, address(quote), 0, DAY);
    }

    function _list(uint256 price) internal returns (uint256 id) {
        uint256 tokenId = _mintApproved();
        vm.prank(seller);
        id = market.list(address(nft), tokenId, address(quote), price);
    }

    function _mintApproved() internal returns (uint256 tokenId) {
        vm.prank(seller);
        tokenId = nft.mint(seller);
        vm.prank(seller);
        nft.approve(address(market), tokenId);
    }

    function _bid(uint256 id, address who, uint256 amount) internal {
        quote.mint(who, amount);
        vm.prank(who);
        quote.approve(address(market), amount);
        vm.prank(who);
        market.bid(id, amount);
    }

    function _high(uint256 id) internal view returns (address winner, uint256 amount) {
        (,,,,,, winner, amount,) = market.auctions(id);
    }

    function _tokenOfAuction(uint256 id) internal view returns (uint256 tokenId) {
        (,, tokenId,,,,,,) = market.auctions(id);
    }

    function _tokenOfListing(uint256 id) internal view returns (uint256 tokenId) {
        (,, tokenId,,,) = market.listings(id);
    }

    function _listingActive(uint256 id) internal view returns (bool active) {
        (,,,,, active) = market.listings(id);
    }
}
