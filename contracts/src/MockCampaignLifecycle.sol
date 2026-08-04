// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IBroadsideCampaigns.sol";

/// @title MockCampaignLifecycle
/// @notice Test-only mock for BroadsideCampaignLifecycle used in governance unit tests.
///         Implements demoteCampaign and terminateCampaign against the IBroadsideCampaigns interface.
contract MockCampaignLifecycle {
    IBroadsideCampaigns public campaigns;
    address public governanceContract;

    event CampaignDemoted(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId, uint256 terminationBlock);

    constructor(address _campaigns) {
        campaigns = IBroadsideCampaigns(_campaigns);
    }

    function setGovernanceContract(address addr) external {
        governanceContract = addr;
    }

    function demoteCampaign(uint256 campaignId) external {
        require(msg.sender == governanceContract, "E19");
        campaigns.setPendingExpiryBlock(campaignId, type(uint256).max);
        campaigns.setCampaignStatus(campaignId, IBroadsideCampaigns.CampaignStatus.Pending);
        emit CampaignDemoted(campaignId);
    }

    function terminateCampaign(uint256 campaignId) external {
        require(msg.sender == governanceContract, "E19");
        campaigns.setTerminationBlock(campaignId, block.number);
        campaigns.setCampaignStatus(campaignId, IBroadsideCampaigns.CampaignStatus.Terminated);
        emit CampaignTerminated(campaignId, block.number);
    }

    event CampaignAdminTerminated(uint256 indexed campaignId, uint16 reasonCode, uint256 terminationBlock);

    function adminTerminateCampaign(uint256 campaignId, uint16 reasonCode) external {
        require(msg.sender == governanceContract, "E19");
        campaigns.setTerminationBlock(campaignId, block.number);
        campaigns.setCampaignStatus(campaignId, IBroadsideCampaigns.CampaignStatus.Terminated);
        emit CampaignAdminTerminated(campaignId, reasonCode, block.number);
    }
}
