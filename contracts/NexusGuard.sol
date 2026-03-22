// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title NexusGuard
 * @notice On-chain risk parameters for Nexus autonomous DeFi agents.
 *
 * The AI agent can READ these limits but CANNOT modify them.
 * Only the contract owner (wallet holder) can update parameters via
 * a direct on-chain transaction — no LLM can forge that signature.
 *
 * This makes risk limits immune to prompt injection:
 * even if the LLM is compromised, it cannot override $500/tx or $2000/day
 * caps because those values live in an immutable on-chain contract.
 *
 * The agent calls getParams() as a read-only view (no gas, no signature).
 * The owner calls updateParams() to change limits — requires wallet signature.
 *
 * Stored parameters (USDT amounts in 6-decimal precision, e.g. 500e6 = $500):
 *   - maxTransactionUsdt  — max single transaction amount
 *   - dailyLimitUsdt      — max daily aggregate spending
 *   - maxSlippageBps      — max swap slippage in basis points (100 = 1%)
 *   - cooldownSeconds     — minimum seconds between risk-gated transactions
 *   - paused              — emergency kill switch, blocks ALL agent transactions
 */
contract NexusGuard {
    address public immutable owner;

    struct RiskParams {
        uint64  maxTransactionUsdt;  // 6-decimal USDT (e.g. 500_000_000 = $500)
        uint64  dailyLimitUsdt;      // 6-decimal USDT (e.g. 2_000_000_000 = $2000)
        uint32  maxSlippageBps;      // basis points (e.g. 100 = 1%)
        uint32  cooldownSeconds;     // min seconds between risk-gated txs
        bool    paused;              // emergency kill switch
    }

    RiskParams private _params;

    event ParamsUpdated(
        uint64  maxTransactionUsdt,
        uint64  dailyLimitUsdt,
        uint32  maxSlippageBps,
        uint32  cooldownSeconds
    );
    event EmergencyPause(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "NexusGuard: not owner");
        _;
    }

    constructor(
        uint64  _maxTxUsdt,
        uint64  _dailyLimitUsdt,
        uint32  _maxSlippageBps,
        uint32  _cooldownSeconds
    ) {
        owner = msg.sender;
        _params = RiskParams({
            maxTransactionUsdt : _maxTxUsdt,
            dailyLimitUsdt     : _dailyLimitUsdt,
            maxSlippageBps     : _maxSlippageBps,
            cooldownSeconds    : _cooldownSeconds,
            paused             : false
        });
        emit ParamsUpdated(_maxTxUsdt, _dailyLimitUsdt, _maxSlippageBps, _cooldownSeconds);
    }

    // ─── Read functions (agent calls these — zero gas, no signature) ─────────

    function getParams() external view returns (
        uint64  maxTransactionUsdt,
        uint64  dailyLimitUsdt,
        uint32  maxSlippageBps,
        uint32  cooldownSeconds,
        bool    paused
    ) {
        RiskParams memory p = _params;
        return (p.maxTransactionUsdt, p.dailyLimitUsdt, p.maxSlippageBps, p.cooldownSeconds, p.paused);
    }

    function isOperational() external view returns (bool) {
        return !_params.paused;
    }

    // ─── Write functions (owner only — requires wallet signature) ────────────

    /**
     * @notice Update all risk parameters atomically.
     * @param _maxTxUsdt        New per-transaction limit (6 decimals, e.g. 500e6 = $500)
     * @param _dailyLimitUsdt   New daily spending cap (6 decimals)
     * @param _maxSlippageBps   New slippage cap in basis points
     * @param _cooldownSeconds  New cooldown period in seconds
     */
    function updateParams(
        uint64  _maxTxUsdt,
        uint64  _dailyLimitUsdt,
        uint32  _maxSlippageBps,
        uint32  _cooldownSeconds
    ) external onlyOwner {
        require(_maxTxUsdt > 0,        "NexusGuard: zero tx limit");
        require(_dailyLimitUsdt > 0,   "NexusGuard: zero daily limit");
        require(_maxTxUsdt <= _dailyLimitUsdt, "NexusGuard: tx limit exceeds daily");
        _params.maxTransactionUsdt = _maxTxUsdt;
        _params.dailyLimitUsdt     = _dailyLimitUsdt;
        _params.maxSlippageBps     = _maxSlippageBps;
        _params.cooldownSeconds    = _cooldownSeconds;
        emit ParamsUpdated(_maxTxUsdt, _dailyLimitUsdt, _maxSlippageBps, _cooldownSeconds);
    }

    /**
     * @notice Emergency pause — blocks ALL autonomous agent transactions.
     * Can only be toggled by the owner's wallet signature.
     */
    function setEmergencyPause(bool _paused) external onlyOwner {
        _params.paused = _paused;
        emit EmergencyPause(_paused);
    }
}
