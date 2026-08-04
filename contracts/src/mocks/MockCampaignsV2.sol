// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideCampaigns.sol";
/// @dev Test-only successor exercising the Campaigns migration write hooks.
contract MockCampaignsV2 is BroadsideCampaigns {
    constructor(uint256 a, uint256 b, address p, address pr) BroadsideCampaigns(a, b, p, pr) {}
    function version() public pure override returns (uint256) { return 3; }
}
