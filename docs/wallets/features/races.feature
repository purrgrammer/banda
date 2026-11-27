# Races across machines. Each scenario fixes ONE interleaving; the other order is its own scenario. The order is
# the order of commits on the one commit line (C1): the harness holds each actor at its fault point and releases them
# in the order the steps say (features/ISOLATION.md, "Races"), so a race scenario is as deterministic as any other.
# Use cases UC-07, UC-08, UC-09, UC-10, UC-13, UC-15, UC-17, UC-19.

Feature: Concurrent acts resolve by commit order, the same way every run

  # C1, C9: the Deny's commit refuses the queued payment; the lane's later start commit finds it refused.
  @UC-09 @UC-10 @H-086 @race
  @t:recipient:ask:list_set_deny:version_current
  @t:payment:Queued:deny_committed:payer=agent
  @t:payment:Refused:start_commit:T
  Scenario: Deny commits first, then the lane's start commit finds the payment refused
    Given the recipient is "ask"
    And the payment is "Queued"
    And the owner's recipient act carries the current version
    And the payer is the agent
    When the owner sets the recipient to Deny in the list
    And a Deny for the payment's recipient commits
    Then the recipient is "deny"
    And the payment is "Refused"
    When the lane runs the start commit
    Then the payment is "Refused"
    And a refused payment is never paid
    And a Deny excludes every Always for that recipient

  # C13: the start commit was first, so the bytes may have left; the Deny applies to every later call.
  @UC-09 @UC-10 @H-086 @H-085 @race
  @t:permission:always:list_set_deny:version_current
  @t:recipient:ask:list_set_deny:version_current
  @t:payment:Signed:deny_committed:T
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  Scenario: The lane's start commit is first, then the Deny commits and the payment finishes
    Given the recipient is "ask"
    And the agent's permission for the recipient is "always"
    And the payment is "Queued"
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    And the payer is the agent
    And the payment's recipient is set to Always
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Signed"
    When the agent's permission takes the list's Deny
    Then the agent's permission for the recipient is "none"
    When the owner sets the recipient to Deny in the list
    Then the recipient is "deny"
    Given the payment's recipient is set to Deny
    When a Deny for the payment's recipient commits
    Then the payment is "Signed"
    And what the chat is told matches the chain

  # C9: Always on one card answers, in the same commit, every open card it covers.
  @UC-08 @H-083 @H-091 @race
  @t:recipient:ask:card_always:version_current
  @t:permission:none:card_always:version_current&rcpt!=deny
  @t:payment:Waiting:always_committed:payer=agent
  Scenario: Always pay on one card queues another open ask for the same agent and recipient
    Given the recipient is "ask"
    And the agent's permission for the recipient is "none"
    And the payment is "Waiting"
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    And the recipient is set to Ask when the act commits
    And the payer is the agent
    When the recipient takes the card answer Always pay
    Then the recipient is "ask"
    When the agent's permission takes the card answer Always pay
    Then the agent's permission for the recipient is "always"
    When an Always for the payment's agent and recipient commits
    Then the payment is "Queued"
    And an Always covers only the agent it was granted to

  # C8: the desktop's Pay commits first; the phone's Always carries the version it saw and is refused.
  @UC-08 @UC-26 @H-141 @H-280 @race
  @t:recipient:unknown:card_pay:version_current
  @t:recipient:ask:card_always:!version_current
  @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
  Scenario: The same card answered on the desktop, then on the phone
    Given the recipient is "unknown"
    And the payment is "Waiting"
    And the payer is the agent
    And the payment's recipient is unknown
    And the wallet's default for unknown recipients is Ask
    And the owner's recipient act carries the current version
    And the answer comes from the host or the recipient is known on the host
    When the owner taps Pay on the payment's card
    And the recipient takes the card answer Pay
    Then the payment is "Queued"
    And the recipient is "ask"
    Given the owner's recipient act carries a stale version
    When the recipient takes the card answer Always pay
    Then the recipient is "ask"
    And no act applies on a version it did not see

  @UC-09 @H-087 @race
  @t:permission:always:list_set_ask:version_current
  @t:recipient:ask:list_set_ask:version_current
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&![payer=agent&eff=deny]&!start_ok
  Scenario: Always is set back to Ask while its payment is queued, and the start commit asks the owner
    Given the recipient is "ask"
    And the agent's permission for the recipient is "always"
    And the payment is "Queued"
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    And the payer is the agent
    And the payment has no fresh approval
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the agent's permission takes the list's Ask
    Then the agent's permission for the recipient is "none"
    When the owner sets the recipient to Ask in the list
    Then the recipient is "ask"
    Given the payment's recipient is set to Ask
    When the lane runs the start commit
    Then the payment is "Waiting"
    And every start rests on Always, a fresh approval or the owner as payer

  @UC-09 @H-088 @race
  @t:permission:always:forget:version_current
  @t:recipient:ask:forget:version_current
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&![payer=agent&eff=deny]&!start_ok
  Scenario: A recipient forgotten while an Always payment is queued asks again at the start commit
    Given the recipient is "ask"
    And the agent's permission for the recipient is "always"
    And the payment is "Queued"
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    And the payer is the agent
    And the wallet's default for unknown recipients is Ask
    And the payment has no fresh approval
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the agent's permission takes the forget
    Then the agent's permission for the recipient is "none"
    When the owner forgets the recipient
    Then the recipient is "unknown"
    Given the payment's recipient is unknown
    When the lane runs the start commit
    Then the payment is "Waiting"

  # C9: the default's change sweeps every open ask for an unknown recipient in its own commit.
  @UC-09 @H-090 @race
  @t:payment:Waiting:deny_committed:payer=agent
  Scenario: The default for unknown recipients becomes Deny while an ask is open
    Given the recipient is "unknown"
    And the payment is "Waiting"
    And the payment's recipient is unknown
    And the wallet's default for unknown recipients is Deny
    And the payer is the agent
    When a Deny for the payment's recipient commits
    Then the payment is "Refused"
    And the recipient is "unknown"
    And an unknown recipient is never Always

  # C11: the first payment's reservation is taken in its admission commit; the second sees what is left.
  @UC-07 @H-132 @race
  @t:payment:Idle:call:wallet_usable&payer=agent&eff!=deny&!fits
  Scenario: Two payments that each fit the balance alone: the second admitted finds the first's reservation
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Always
    And the available balance does not cover the payment
    When the payment is requested
    Then the payment is "Refused"
    And the wallet never spends more than was funded

  # C17: archive refuses the queued payments of the wallet in its own commit; an archived wallet does not send.
  @UC-17 @UC-13 @H-047 @race
  @t:wallet:ready_saved:archive:version_current
  @t:payment:Queued:cancel_or_switch_off:T
  Scenario: The owner archives the wallet while the owner's Send is queued
    Given the wallet is "ready_saved"
    And the payment is "Queued"
    And the owner's wallet act carries the current version
    When the owner archives the wallet
    And the run is cancelled or the wallet is switched off for the payer
    Then the wallet is "archived"
    And the payment is "Refused"

  @UC-05 @UC-13 @UC-10 @H-054 @H-143 @race
  @t:payment:Queued:cancel_or_switch_off:T
  @t:payment:Refused:start_commit:T
  Scenario: The wallet is switched off first, then the lane's start commit finds the payment refused
    Given the payment is "Queued"
    When the run is cancelled or the wallet is switched off for the payer
    Then the payment is "Refused"
    When the lane runs the start commit
    Then the payment is "Refused"

  @UC-05 @UC-13 @H-054 @H-124 @race
  @t:payment:Signed:cancel_or_switch_off:T
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  Scenario: The lane's start commit is first, then the switch-off lets the payment finish
    Given the payment is "Queued"
    And the payer is the agent
    And the payment's recipient is set to Always
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Signed"
    When the run is cancelled or the wallet is switched off for the payer
    Then the payment is "Signed"
    And what the chat is told matches the chain

  # C7: the lane and the payment both wait for the foreign transaction's finality before deciding anything.
  # Evidence: spikes/gaps/README.md §A: the finalized count and block follow latest - 2N on anvil 1.9.0.
  @UC-15 @H-167 @H-171 @race
  @t:nonce:in_flight:foreign_at_nonce:!above_final
  @t:payment:Sent:receipt:blk=foreign&!blk_fin
  @t:nonce:in_flight:foreign_at_nonce:above_final&verified @t:payment:Sent:receipt:blk=foreign&blk_fin&verified
  Scenario: A foreign transaction lands at the in-flight nonce, and nothing is decided before finality
    Given the nonce lane is "in_flight"
    And the payment is "Sent"
    And the nonce is not yet used at finalized
    And a foreign transaction holds the payment's nonce
    And that block is not finalized
    When a foreign transaction is seen at the in-flight nonce
    And the lane reads the receipt at the payment's nonce
    Then the nonce lane is "in_flight"
    And the payment is "Sent"
    Given the nonce is used at finalized
    And that block is finalized
    And the foreign transaction is proven
    When a foreign transaction is seen at the in-flight nonce
    Given the RPC's claim is proven
    When the lane reads the receipt at the payment's nonce
    Then the nonce lane is "free"
    And the payment is "Waiting"
    And the payment is on chain at most once
    And the ledger is raised only at finalized

  # C9: the restore answers the lane's "key missing" Wait; the lane's next turn signs its head payment.
  @UC-19 @H-290 @race
  @t:nonce:free:lane_turn:queued&!can_sign&!chain_ahead
  @t:signing:key_missing:restore_key:derives
  @t:nonce:free:lane_turn:queued&can_sign&!chain_ahead
  Scenario: Restore key while the lane waits for the key
    Given the signer is "key_missing"
    And the nonce lane is "free"
    And the signer's key derives the wallet's address
    And a payment is queued in the lane
    And the chain's count is explained by the ledger
    And the signer cannot read or prove the key
    When the nonce lane takes its next turn
    Then the nonce lane is "free"
    When the owner restores the key
    Then the signer is "online"
    Given the signer can read and prove the key
    When the nonce lane takes its next turn
    Then the nonce lane is "signing"
    And nonces follow the lane's queue order

  # C6, C13, C21 (finding 20): the owner's Cancel on a Sent row is a zero-value transfer to the wallet itself at the
  # same nonce with raised fees, stored and synced before it leaves; whichever stored version is mined decides. A
  # mined cancel ends Cancelled (not paid, the fee spent), a mined paying version Confirmed, never both.
  # Evidence: PaymentLane_cancel and _pair_cancel_bump (model/README.md).
  @UC-13 @H-124 @race
  Scenario Outline: The owner cancels a sent payment while its bump is out, and whichever version is mined decides
    Given the payment is "Sent"
    When the owner cancels the sent payment
    Then the payment is "Sent"
    Given <mined>
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    Given that block is finalized
    And the receipt's status is 1
    When the payment's block reaches finality
    Then the payment is "<after>"
    And the payment is on chain at most once
    And what the chat is told matches the chain

    @t:payment:Sent:cancel_replace:T @t:payment:Sent:receipt:blk=own|blk=own_cancel
    @t:payment:Included:finality:blk_fin&blk=own_cancel
    Examples: the cancel is mined
      | mined                                              | after     |
      | the receipt names the payment's cancel replacement | Cancelled |

    @t:payment:Sent:cancel_replace:T @t:payment:Sent:receipt:blk=own|blk=own_cancel
    @t:payment:Included:finality:blk_fin&blk!=own_cancel&blk_ok
    Examples: the bump's paying version is mined first
      | mined                                             | after     |
      | the receipt names a stored version of the payment | Confirmed |
