// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideCampaignAllowlist.sol";
contract MockCampaignAllowlistV2 is BroadsideCampaignAllowlist {
    function version() public pure override returns (uint256) { return 2; }
}
