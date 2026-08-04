// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsidePeopleChainXcmBridge.sol";
contract MockPeopleChainXcmBridgeV2 is BroadsidePeopleChainXcmBridge {
    constructor(address x, address c) BroadsidePeopleChainXcmBridge(x, c) {}
    function version() public pure override returns (uint256) { return 2; }
}
