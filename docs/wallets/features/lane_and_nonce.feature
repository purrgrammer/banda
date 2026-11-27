# Machine: nonce (one lane per wallet, FIFO, one transaction in flight). Use cases UC-10, UC-15, UC-19.
# C2 one lane per wallet; C4 the fused start commit is the burn point; C5 the nonce ledger is raised only at
# finalized; C7 a foreign nonce waits for finalized. Evidence: spikes/nonce-and-crash/README.md on anvil 1.9.0:
# 127 of 127 crash runs paid once; a nonce taken when a draft opens left a gap (rejected design); a second sender
# with the same key (section 5) and a reorg (section 8) were replayed with anvil_reorg.

Feature: The wallet's lane takes nonces in order, one at a time

  @UC-10 @H-164 @H-165 @best
  @t:nonce:free:lane_turn:queued&can_sign&!chain_ahead
  @t:nonce:signing:start_commit:!ledger_moved&recheck_ok
  @t:nonce:in_flight:included_latest:!more_in_flight
  Scenario: The lane signs its head payment, takes the next nonce at the start commit, and frees it at inclusion
    Given the nonce lane is "free"
    And a payment is queued in the lane
    And the signer can read and prove the key
    And the chain's count is explained by the ledger
    And the lane's ledger is as the signer read it
    And the start commit's re-check passes
    And no other nonce is in flight
    When the nonce lane takes its next turn
    Then the nonce lane is "signing"
    When the nonce lane runs its start commit
    Then the nonce lane is "in_flight"
    When the in-flight nonce is included at latest
    Then the nonce lane is "free"
    And each lane effect is on chain at most once
    And no two payments share a nonce
    And nonces follow the lane's queue order
    And the wallet's nonces have no gap
    And at most one nonce is in flight

  # H-027: no nonce is taken while the key cannot be read; the payment stays queued and nothing is burnt.
  @UC-10 @UC-19 @H-027 @H-026 @error
  @t:nonce:free:lane_turn:queued&!can_sign&!chain_ahead
  Scenario: The key cannot be read, so the lane takes no nonce and waits
    Given the nonce lane is "free"
    And a payment is queued in the lane
    And the signer cannot read or prove the key
    And the chain's count is explained by the ledger
    When the nonce lane takes its next turn
    Then the nonce lane is "free"
    And the wallet's nonces have no gap

  @UC-11 @H-202
  @t:nonce:free:lane_turn:!queued&!chain_ahead
  Scenario: An empty lane stays free at its turn
    Given the nonce lane is "free"
    And no payment is queued in the lane
    And the chain's count is explained by the ledger
    When the nonce lane takes its next turn
    Then the nonce lane is "free"

  # C5, C21: a count above the ledger that no stored hash explains blocks the lane until that count is finalized.
  # Evidence: spikes/gaps/README.md §A: on anvil 1.9.0 the count at finalized follows latest - 2N
  # (--slots-in-an-epoch N), so 'used at finalized' is 2N blocks mined after the foreign inclusion; §C: on Base,
  # finalized trails latest by about 18 min (Sepolia) and 20 min (mainnet).
  @UC-15 @UC-11 @H-166 @H-129
  @t:nonce:free:lane_turn:chain_ahead
  @t:nonce:blocked:finality:!above_final
  @t:nonce:blocked:finality:above_final
  Scenario: The exported key was used elsewhere while banda was idle, and the lane waits for finality
    Given the nonce lane is "free"
    And the chain's count is above the ledger without a stored hash to explain it
    And the nonce is not yet used at finalized
    When the nonce lane takes its next turn
    Then the nonce lane is "blocked"
    When the nonce lane reads the finalized count
    Then the nonce lane is "blocked"
    Given the nonce is used at finalized
    When the nonce lane reads the finalized count
    Then the nonce lane is "free"
    And the ledger is raised only at finalized
    And the nonce ledger never moves down

  @UC-10 @H-164 @race
  @t:nonce:signing:start_commit:ledger_moved|!recheck_ok
  Scenario: Another driver moved the ledger since signing, and the start commit takes no nonce
    Given the nonce lane is "signing"
    And the lane's ledger moved since signing
    When the nonce lane runs its start commit
    Then the nonce lane is "free"
    And no two payments share a nonce

  @UC-10 @H-133
  @t:nonce:signing:start_commit:ledger_moved|!recheck_ok
  Scenario: The start commit's re-check fails, and no nonce is burnt
    Given the nonce lane is "signing"
    And the lane's ledger is as the signer read it
    And the start commit's re-check fails
    When the nonce lane runs its start commit
    Then the nonce lane is "free"
    And the wallet's nonces have no gap

  # Evidence: spikes/gaps/README.md §A (finalized = latest - 2N on anvil) and §D: on geth 1.17.10 and reth 2.10.1 a
  # foreign version at the in-flight nonce makes banda's rebroadcast 'replacement transaction underpriced' while
  # pending and 'nonce too low: next nonce …' once mined.
  @UC-15 @H-167 @race
  @t:nonce:in_flight:foreign_at_nonce:!above_final
  @t:nonce:in_flight:foreign_at_nonce:above_final&verified
  Scenario: A foreign transaction at the in-flight nonce frees the lane only once finalized
    Given the nonce lane is "in_flight"
    And the nonce is not yet used at finalized
    When a foreign transaction is seen at the in-flight nonce
    Then the nonce lane is "in_flight"
    Given the nonce is used at finalized
    And the foreign transaction is proven
    When a foreign transaction is seen at the in-flight nonce
    Then the nonce lane is "free"
    And each lane effect is on chain at most once
    And the ledger is raised only at finalized

  # nonce-and-crash spike section 8: a reorg undoes an inclusion; the stored bytes land again, once.
  # Evidence: spikes/gaps/README.md §A: anvil_reorg returns null, keeps the heads, and does not return the removed
  # transaction to the pool; the rebroadcast stored bytes land again with the same hash. anvil also rewrites
  # finalized blocks, so the step stays within 2N.
  @UC-10 @H-176 @H-181 @race
  Scenario Outline: A reorg undoes an inclusion, and the lane holds that nonce in flight again
    Given the nonce lane is "<from>"
    When a reorg undoes an inclusion
    Then the nonce lane is "in_flight"
    And at most one nonce is in flight

    @t:nonce:free:reorg_undoes_inclusion:T
    Examples: the next payment had not started
      | from |
      | free |

    @t:nonce:in_flight:reorg_undoes_inclusion:T
    Examples: already in flight
      | from      |
      | in_flight |

  # Evidence: spikes/gaps/README.md §A: a transaction listed in anvil_reorg is dropped silently when an earlier
  # nonce of its sender is not included first, so the step re-includes in nonce order.
  @UC-10 @H-176 @edge
  @t:nonce:in_flight:included_latest:more_in_flight
  Scenario: After a reorg, the earlier nonce is included while a later one is still in flight
    Given the nonce lane is "in_flight"
    And a later nonce is in flight after a reorg
    When the in-flight nonce is included at latest
    Then the nonce lane is "in_flight"
    And nonces follow the lane's queue order

  # C7 (finding 2): an RPC alone cannot move the lane. A foreign transaction or a status-0 receipt counts only when
  # the transaction is fetched, its signer recovers to the wallet at the nonce, and a second, independent RPC agrees
  # at finalized; otherwise the payment and the lane stay where they are and the owner is told the RPC disagrees.
  # Evidence: PaymentLane_bug_C7 and _bug_C12rpc (model/README.md) pay twice once one RPC's word is enough.
  @UC-15 @H-168 @security
  @t:payment:Sent:receipt:blk=foreign&blk_fin&!verified
  Scenario: A lying RPC claims a foreign transaction at the payment's nonce, and the payment stays Sent
    Given the payment is "Sent"
    And a foreign transaction holds the payment's nonce
    And that block is finalized
    And the RPC's claim cannot be verified
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Sent"
    And the payment is on chain at most once

  @UC-10 @H-189 @security
  @t:payment:Included:finality:blk_fin&blk!=own_cancel&!blk_ok&!verified
  Scenario: A lying RPC claims a status-0 receipt, and the payment stays Included
    Given the payment is "Included"
    And the receipt names a stored version of the payment
    And the receipt's status is 0
    And that block is finalized
    And the RPC's claim cannot be verified
    When the payment's block reaches finality
    Then the payment is "Included"
    And what the chat is told matches the chain

  @UC-15 @H-168 @security
  @t:nonce:in_flight:foreign_at_nonce:above_final&!verified
  Scenario: A lying RPC claims a foreign transaction at the in-flight nonce, and the lane stays in flight
    Given the nonce lane is "in_flight"
    And the nonce is used at finalized
    And the foreign transaction cannot be verified
    When a foreign transaction is seen at the in-flight nonce
    Then the nonce lane is "in_flight"
    And the ledger is raised only at finalized
