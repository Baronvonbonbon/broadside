// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./BroadsidePlumbingLockable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IBroadsideCampaigns.sol";
import "./interfaces/IBroadsidePublishers.sol";
import "./interfaces/IBroadsideBudgetLedger.sol";
import "./interfaces/IBroadsideChallengeBonds.sol";
import "./interfaces/IBroadsideAdvertiserStake.sol";
import "./interfaces/IBroadsideCampaignAllowlist.sol";
import "./interfaces/IBroadsideTagSystem.sol";

/// @title  BroadsideCampaignsMigrationLogic
/// @notice DELEGATECALL target for BroadsideCampaigns' upgrade-import. It mirrors
///         BroadsideCampaigns' storage layout EXACTLY (same base chain + the same
///         36 state variables in the same order), so writes here land in
///         BroadsideCampaigns' storage when reached via delegatecall. This keeps the
///         (heavy) full per-campaign import code OFF BroadsideCampaigns'
///         EIP-170-bound bytecode while adding zero cross-contract reads to the
///         per-claim hot path — the Storage+Logic split as BroadsideSettlement, but
///         applied only to the migration surface.
///
/// @dev    The layout duplication (rather than a shared storage base) is
///         deliberate: IBroadsideCampaigns names eight of these state variables as
///         interface getters, so a shared interface-free base would force
///         BroadsideCampaigns to drop the interface (cascading struct/enum/event
///         qualification + a createCampaign stack-depth blow-up). Duplicating the
///         layout here keeps BroadsideCampaigns byte-identical to its audited form;
///         drift is caught by the storage-layout-invariant test
///         (test/campaigns-migration-layout.test.ts). Children must NOT reorder
///         these fields, and any BroadsideCampaigns storage change must be mirrored
///         here. Deployed once, wired via BroadsideCampaigns.setMigrationLogic, and
///         only entered through the governance-gated migrateImportCampaignFull.
contract BroadsideCampaignsMigrationLogic is BroadsidePlumbingLockable, PaseoSafeSender {
    // ── Storage layout — MUST stay identical to BroadsideCampaigns (slots 0..n) ──
    uint16 public defaultTakeRateBps;
    uint256 public maxCampaignBudget;
    uint256 public minimumCpmFloor;
    uint256 public pendingTimeoutBlocks;
    bool public minimumCpmFloorLocked;
    bool public pendingTimeoutBlocksLocked;
    address public parameterGovernance;
    address public settlementContract;
    address public governanceContract;
    address public lifecycleContract;
    IBroadsidePublishers public publishers;
    IBroadsideBudgetLedger public budgetLedger;
    address public pendingSettlementContract;
    address public pendingGovernanceContract;
    address public pendingLifecycleContract;
    address public pendingBudgetLedger;
    bool public bootstrapped;
    uint256 public nextCampaignId;
    mapping(uint256 => IBroadsideCampaigns.Campaign) internal _campaigns;
    mapping(uint256 => IBroadsideCampaigns.ActionPotConfig[]) internal _campaignPots;
    IBroadsideChallengeBonds public challengeBonds;
    address public activationBonds;
    IBroadsideTagSystem public tagSystem;
    mapping(address => address) public advertiserRelaySigner;
    IBroadsideAdvertiserStake public advertiserStake;
    mapping(uint256 => bool) public campaignAllowlistEnabled;
    mapping(uint256 => mapping(address => bool)) public campaignAllowlistSnapshot;
    IBroadsideCampaignAllowlist public allowlist;
    mapping(uint256 => uint8) public campaignAssuranceLevel;
    mapping(uint256 => uint256) public campaignMinStake;
    uint256 public maxAllowedMinStake;
    mapping(uint256 => bytes32) public campaignRequiredCategory;
    mapping(uint256 => uint32) public userEventCapPerWindow;
    mapping(uint256 => uint32) public userCapWindowBlocks;
    mapping(uint256 => uint32) public minUserSettledHistory;
    mapping(uint256 => uint8) public campaignMinIdentityLevel;
    address public migrationLogic;
    // ── End mirrored storage layout ──

    /// @dev Full per-campaign state bundle replayed by the migrator (off-chain)
    ///      into a fresh BroadsideCampaigns during a redeploy-migrate upgrade.
    ///      (campaignAllowlistSnapshot — the legacy nested per-campaign publisher
    ///      allowlist — is NOT included; the canonical allowlist lives in the
    ///      separately-migrated BroadsideCampaignAllowlist.)
    struct CampaignFullImport {
        IBroadsideCampaigns.Campaign core;
        IBroadsideCampaigns.ActionPotConfig[] pots;
        bool    allowlistEnabled;
        uint8   assuranceLevel;
        uint256 minStake;
        bytes32 requiredCategory;
        uint32  userEventCap;
        uint32  userCapWindow;
        uint32  minHistory;
        uint8   minIdentityLevel;
    }

    function version() public pure override returns (uint256) { return 1; }

    /// @dev Replay one campaign's FULL state into storage. Run under DELEGATECALL
    ///      from BroadsideCampaigns; the governance gate lives on the dispatcher.
    function importCampaignFull(uint256 id, CampaignFullImport calldata c) external {
        _campaigns[id] = c.core;
        delete _campaignPots[id];
        for (uint256 i = 0; i < c.pots.length; i++) {
            _campaignPots[id].push(c.pots[i]);
        }
        campaignAllowlistEnabled[id]  = c.allowlistEnabled;
        campaignAssuranceLevel[id]    = c.assuranceLevel;
        campaignMinStake[id]          = c.minStake;
        campaignRequiredCategory[id]  = c.requiredCategory;
        userEventCapPerWindow[id]     = c.userEventCap;
        userCapWindowBlocks[id]       = c.userCapWindow;
        minUserSettledHistory[id]     = c.minHistory;
        campaignMinIdentityLevel[id]  = c.minIdentityLevel;
    }
}
