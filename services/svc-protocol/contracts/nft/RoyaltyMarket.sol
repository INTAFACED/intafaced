// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

interface IERC721Escrow {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC2981Royalty {
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount);
}

/**
 * ROYALTY MARKET — Protocol Plane (board S-G3 / `launch.nft`).
 *
 * Fixed-price list and a one-lot English auction. The NFT is escrowed here.
 * The buyer (or highest bidder) pays a quote ERC-20; this contract pays the
 * ERC-2981 royalty to the receiver and the remainder to the seller, then
 * transfers the NFT. That split is not optional and is not honour-system.
 * A bid or sale is credited only the quote balance the transfer actually
 * added. A short or zero receipt is not a winning bid and is not a sale.
 *
 * No platform fee. No owner. NOT AUDITED.
 */
contract RoyaltyMarket {
    struct Listing {
        address seller;
        address nft;
        uint256 tokenId;
        address quote;
        uint256 price;
        bool active;
    }

    struct Auction {
        address seller;
        address nft;
        uint256 tokenId;
        address quote;
        uint256 minBid;
        uint64 endTime;
        address highestBidder;
        uint256 highestBid;
        bool settled;
    }

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    uint256 public nextAuctionId = 1;
    mapping(uint256 => Auction) public auctions;

    struct Pending {
        address seller;
        uint256 id;
        bool auction;
    }

    /// Set while `list` or `startAuction` is waiting for the token it just asked for.
    mapping(address nft => mapping(uint256 tokenId => Pending)) private pending;
    /// Seller recorded when that asked-for token actually arrived.
    mapping(address nft => mapping(uint256 tokenId => address seller)) public escrowedFrom;

    event Listed(uint256 indexed id, address indexed seller, address indexed nft, uint256 tokenId, address quote, uint256 price);
    event Cancelled(uint256 indexed id);
    event Sold(uint256 indexed id, address indexed buyer, uint256 price, uint256 royalty, address royaltyReceiver);
    event AuctionStarted(
        uint256 indexed id,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        address quote,
        uint256 minBid,
        uint64 endTime
    );
    event BidPlaced(uint256 indexed id, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed id, address indexed winner, uint256 price, uint256 royalty, address royaltyReceiver);

    error BadParams();
    error Inactive();
    error NotSeller();
    error PaymentTooLow();
    error TransferFailed();
    error AuctionLive();
    error AuctionOver();
    error BidTooLow();
    error UnexpectedNft();

    function list(address nft, uint256 tokenId, address quote, uint256 price) external returns (uint256 id) {
        if (nft == address(0) || quote == address(0) || price == 0) revert BadParams();
        id = nextListingId;
        nextListingId = id + 1;
        listings[id] = Listing(msg.sender, nft, tokenId, quote, price, false);
        _expect(nft, tokenId, id, false);
        IERC721Escrow(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        if (!listings[id].active || escrowedFrom[nft][tokenId] != msg.sender) revert UnexpectedNft();
        emit Listed(id, msg.sender, nft, tokenId, quote, price);
    }

    function cancel(uint256 listingId) external {
        Listing storage L = listings[listingId];
        if (!L.active) revert Inactive();
        if (L.seller != msg.sender) revert NotSeller();
        if (escrowedFrom[L.nft][L.tokenId] != L.seller) revert Inactive();
        L.active = false;
        escrowedFrom[L.nft][L.tokenId] = address(0);
        IERC721Escrow(L.nft).transferFrom(address(this), L.seller, L.tokenId);
        emit Cancelled(listingId);
    }

    function buy(uint256 listingId) external {
        Listing storage L = listings[listingId];
        if (!L.active) revert Inactive();
        if (escrowedFrom[L.nft][L.tokenId] != L.seller) revert Inactive();
        L.active = false;
        escrowedFrom[L.nft][L.tokenId] = address(0);
        (uint256 royalty, address receiver, uint256 paid) =
            _takePayment(L.nft, L.tokenId, L.quote, L.price, L.seller, msg.sender);
        IERC721Escrow(L.nft).transferFrom(address(this), msg.sender, L.tokenId);
        emit Sold(listingId, msg.sender, paid, royalty, receiver);
    }

    function startAuction(
        address nft,
        uint256 tokenId,
        address quote,
        uint256 minBid,
        uint32 duration
    ) external returns (uint256 id) {
        if (nft == address(0) || quote == address(0) || duration == 0) revert BadParams();
        id = nextAuctionId;
        nextAuctionId = id + 1;
        uint64 endTime = uint64(block.timestamp) + duration;
        auctions[id] = Auction(msg.sender, nft, tokenId, quote, minBid, endTime, address(0), 0, false);
        _expect(nft, tokenId, id, true);
        IERC721Escrow(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        if (escrowedFrom[nft][tokenId] != msg.sender) revert UnexpectedNft();
        emit AuctionStarted(id, msg.sender, nft, tokenId, quote, minBid, endTime);
    }

    function bid(uint256 auctionId, uint256 amount) external {
        Auction storage A = auctions[auctionId];
        if (A.settled || A.seller == address(0)) revert Inactive();
        if (escrowedFrom[A.nft][A.tokenId] != A.seller) revert Inactive();
        if (block.timestamp >= A.endTime) revert AuctionOver();
        if (amount < A.minBid || amount <= A.highestBid) revert BidTooLow();
        uint256 received = _creditQuote(A.quote, msg.sender, amount);
        address prev = A.highestBidder;
        uint256 prevBid = A.highestBid;
        A.highestBidder = msg.sender;
        A.highestBid = received;
        if (prev != address(0)) _payHeld(A.quote, prev, prevBid);
        emit BidPlaced(auctionId, msg.sender, received);
    }

    function endAuction(uint256 auctionId) external {
        Auction storage A = auctions[auctionId];
        if (A.settled || A.seller == address(0)) revert Inactive();
        if (block.timestamp < A.endTime) revert AuctionLive();
        if (escrowedFrom[A.nft][A.tokenId] != A.seller) revert Inactive();
        A.settled = true;
        escrowedFrom[A.nft][A.tokenId] = address(0);
        if (A.highestBidder == address(0)) {
            IERC721Escrow(A.nft).transferFrom(address(this), A.seller, A.tokenId);
            emit AuctionSettled(auctionId, address(0), 0, 0, address(0));
            return;
        }
        (uint256 royalty, address receiver) = _splitHeld(A.nft, A.tokenId, A.quote, A.highestBid, A.seller);
        IERC721Escrow(A.nft).transferFrom(address(this), A.highestBidder, A.tokenId);
        emit AuctionSettled(auctionId, A.highestBidder, A.highestBid, royalty, receiver);
    }

    /// @dev Accepts `safeTransferFrom` only for a token a listing or auction already expects from that sender.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        Pending memory p = pending[msg.sender][tokenId];
        if (p.seller == address(0) || from != p.seller) revert UnexpectedNft();
        delete pending[msg.sender][tokenId];
        if (IERC721Escrow(msg.sender).ownerOf(tokenId) != address(this)) revert UnexpectedNft();
        if (escrowedFrom[msg.sender][tokenId] != address(0)) revert UnexpectedNft();
        if (p.auction) {
            Auction storage A = auctions[p.id];
            if (A.settled || A.seller != from || A.nft != msg.sender || A.tokenId != tokenId) revert UnexpectedNft();
        } else {
            Listing storage L = listings[p.id];
            if (L.active || L.seller != from || L.nft != msg.sender || L.tokenId != tokenId) revert UnexpectedNft();
            L.active = true;
        }
        escrowedFrom[msg.sender][tokenId] = from;
        return 0x150b7a02;
    }

    function _expect(address nft, uint256 tokenId, uint256 id, bool auction) private {
        if (pending[nft][tokenId].seller != address(0) || escrowedFrom[nft][tokenId] != address(0)) revert BadParams();
        pending[nft][tokenId] = Pending(msg.sender, id, auction);
    }

    function _takePayment(
        address nft,
        uint256 tokenId,
        address quote,
        uint256 price,
        address seller,
        address payer
    ) private returns (uint256 royalty, address receiver, uint256 paid) {
        paid = _creditQuote(quote, payer, price);
        (royalty, receiver) = _splitHeld(nft, tokenId, quote, paid, seller);
    }

    /// @dev Credits the quote balance added by this pull. Zero or a shortfall reverts, so the caller-stated amount is never booked.
    function _creditQuote(address quote, address from, uint256 requiredAmount) private returns (uint256 received) {
        uint256 beforeBal = IERC20Minimal(quote).balanceOf(address(this));
        if (!IERC20Minimal(quote).transferFrom(from, address(this), requiredAmount)) revert PaymentTooLow();
        uint256 afterBal = IERC20Minimal(quote).balanceOf(address(this));
        if (afterBal <= beforeBal) revert PaymentTooLow();
        received = afterBal - beforeBal;
        if (received == 0 || received < requiredAmount) revert PaymentTooLow();
    }

    function _splitHeld(
        address nft,
        uint256 tokenId,
        address quote,
        uint256 price,
        address seller
    ) private returns (uint256 royalty, address receiver) {
        (receiver, royalty) = _royaltyOf(nft, tokenId, price);
        if (royalty > price) royalty = price;
        if (royalty == 0 || receiver == address(0)) {
            royalty = 0;
            receiver = address(0);
            _payHeld(quote, seller, price);
            return (0, address(0));
        }
        _payHeld(quote, receiver, royalty);
        _payHeld(quote, seller, price - royalty);
    }

    /// @dev Sends `amount` and reverts unless this contract's quote balance fell by exactly that amount.
    function _payHeld(address quote, address to, uint256 amount) private {
        uint256 beforeBal = IERC20Minimal(quote).balanceOf(address(this));
        if (beforeBal < amount) revert TransferFailed();
        if (!IERC20Minimal(quote).transfer(to, amount)) revert TransferFailed();
        if (beforeBal - IERC20Minimal(quote).balanceOf(address(this)) != amount) revert TransferFailed();
    }

    function _royaltyOf(address nft, uint256 tokenId, uint256 price) private view returns (address receiver, uint256 amount) {
        try IERC2981Royalty(nft).royaltyInfo(tokenId, price) returns (address r, uint256 a) {
            return (r, a);
        } catch {
            return (address(0), 0);
        }
    }
}
