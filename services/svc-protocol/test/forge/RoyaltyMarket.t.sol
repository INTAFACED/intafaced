// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoyaltyMarket} from "../../contracts/nft/RoyaltyMarket.sol";
import {SovereignNft} from "../../contracts/nft/SovereignNft.sol";

/// safeTransferFrom into the market sticks only when that market already asked for the token.
contract RoyaltyMarketForgeTest {
    function test_unsolicited_safeTransfer_reverts_and_expected_delivery_cancels() public {
        SovereignNft nft = new SovereignNft("Sovereign", "SOV");
        RoyaltyMarket market = new RoyaltyMarket();
        uint256 unexpectedId = nft.mint(address(this));
        uint256 askedId = nft.mint(address(this));

        try nft.safeTransferFrom(address(this), address(market), unexpectedId) {
            revert("unsolicited");
        } catch {}
        require(nft.ownerOf(unexpectedId) == address(this), "sender keeps the NFT");
        require(market.escrowedFrom(address(nft), unexpectedId) == address(0), "unsolicited recorded nothing");

        nft.approve(address(market), askedId);
        uint256 id = market.list(address(nft), askedId, address(0xC0DE), 1);
        require(nft.ownerOf(askedId) == address(market), "market holds the asked NFT");
        require(market.escrowedFrom(address(nft), askedId) == address(this), "escrow recorded");
        (address seller, , , , , bool active) = market.listings(id);
        require(seller == address(this) && active, "listing records the seller");

        market.cancel(id);
        require(nft.ownerOf(askedId) == address(this), "cancel returns it");
        require(nft.ownerOf(unexpectedId) == address(this), "unsolicited still with sender");
        require(market.escrowedFrom(address(nft), askedId) == address(0), "escrow cleared");
        require(nft.balanceOf(address(market)) == 0, "market holds nothing");
    }
}
