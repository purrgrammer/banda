# The transaction list and the agent's reads are derived from the store and the chain (C22). Use cases UC-06, UC-14.
# Each row's state is a state of the payment machine; "sent outside banda" is a nonce move with no stored effect.
# Evidence: spikes/tx-history/README.md (self-index with eth_getLogs on the pinned token and balance bisection for
# ETH; mainnet.base.org answered 429 to eth_getLogs, so Settings says how far back the list is complete).

Feature: The owner sees every payment's state, and the agent reads its own

  # Evidence: spikes/gaps/README.md §E: Base receipts carry l1Fee and the sender's balance falls by it too; anvil's
  # receipts never do.
  @UC-14 @UC-06 @H-201 @H-206 @H-312
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=always&fits
  @t:payment:Signed:broadcast:T
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  Scenario: An Always payment in a quiet routine run shows in the list and in the agent's history
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Always
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    When the payment is requested
    Then the payment is "Queued"
    When the lane runs the start commit
    Then the payment is "Signed"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    And what the chat is told matches the chain

  @UC-14 @H-201
  @t:payment:Included:finality:blk_fin&blk!=own_cancel&!blk_ok&verified
  Scenario: A failed payment is listed as Failed, never as paid
    Given the payment is "Included"
    And that block is finalized
    And the receipt's status is 0
    And the RPC's claim is proven
    And the receipt names a stored version of the payment
    When the payment's block reaches finality
    Then the payment is "Failed"
    And what the chat is told matches the chain

  # Evidence: spikes/gaps/README.md §A: eth_getTransactionCount at finalized follows latest - 2N on anvil; §C: Base
  # serves it at finalized.
  @UC-14 @H-210
  @t:nonce:blocked:finality:above_final
  Scenario: A nonce used by the exported key elsewhere is listed as sent outside banda once finalized
    Given the nonce lane is "blocked"
    And the nonce is used at finalized
    When the nonce lane reads the finalized count
    Then the nonce lane is "free"
    And the ledger is raised only at finalized
