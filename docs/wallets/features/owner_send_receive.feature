# Machine: payment with the owner as payer, and wallet.show_receive. Use cases UC-03, UC-12, UC-15.
# The owner's Send enters the same lane as the agents' payments (C2); its start rests on the owner as payer
# (StartBasis); it grants agents nothing. Evidence: spikes/nonce-and-crash/README.md (one lane, FIFO, one in flight).

Feature: The owner sends from a wallet and receives into it

  # Evidence: spikes/gaps/README.md §A (finalized = latest - 2N on anvil) and §E: a Base receipt carries l1Fee, and
  # the fee the row shows is gasUsed x effectiveGasPrice + l1Fee.
  @UC-12 @H-252 @best
  @t:payment:Idle:call:wallet_usable&payer=owner&fits
  @t:payment:Signed:broadcast:T
  @t:payment:Included:finality:blk_fin&blk!=own_cancel&blk_ok @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits @t:payment:Sent:receipt:blk=own|blk=own_cancel
  Scenario: The owner sends, the payment goes through the lane and is Confirmed
    Given the payment is "Idle"
    And the payer is the owner
    And the wallet is usable by the payer
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    And the receipt names a stored version of the payment
    And that block is finalized
    And the receipt's status is 1
    When the payment is requested
    Then the payment is "Queued"
    When the lane runs the start commit
    Then the payment is "Signed"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    When the payment's block reaches finality
    Then the payment is "Confirmed"
    And every start rests on Always, a fresh approval or the owner as payer
    And the payment is on chain at most once

  @UC-12 @H-106 @H-107
  @t:payment:Idle:call:wallet_usable&payer=owner&fits
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  Scenario: The owner sends to a recipient agents may never pay, and the Deny stays for agents
    Given the payment is "Idle"
    And the payer is the owner
    And the wallet is usable by the payer
    And the payment's recipient is set to Deny
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    When the payment is requested
    Then the payment is "Queued"
    When the lane runs the start commit
    Then the payment is "Signed"
    And a Deny holds for every agent of the wallet

  @UC-12 @H-257 @error
  @t:payment:Idle:call:wallet_usable&payer=owner&!fits
  Scenario: An owner's Send the balance does not cover is refused before the lane
    Given the payment is "Idle"
    And the payer is the owner
    And the wallet is usable by the payer
    And the available balance does not cover the payment
    When the payment is requested
    Then the payment is "Refused"
    And the wallet never spends more than was funded

  @UC-12 @H-257 @error
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&!fits
  Scenario: The balance dropped before the owner's Send reached its start commit
    Given the payment is "Queued"
    And the payer is the owner
    And the available balance does not cover the payment
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Refused"

  # C7: after a foreign transaction at its nonce is finalized, the owner's Send waits for the owner on a card.
  # Evidence: spikes/gaps/README.md §D: the verbatim answers to a foreign version at the nonce on geth and reth.
  @UC-12 @UC-15 @H-167 @H-254
  @t:payment:Sent:receipt:blk=foreign&blk_fin&verified
  @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
  Scenario: The owner's Send lost its nonce to a foreign transaction and the owner sends it again
    Given the payment is "Sent"
    And the payer is the owner
    And a foreign transaction holds the payment's nonce
    And that block is finalized
    And the RPC's claim is proven
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Waiting"
    Given the answer comes from the host or the recipient is known on the host
    When the owner taps Pay on the payment's card
    Then the payment is "Queued"
    And the payment is on chain at most once

  @UC-12 @H-107
  Scenario Outline: Rule answers and rule commits do not move the owner's waiting Send
    Given the payment is "Waiting"
    And the payer is the owner
    When <act>
    Then the payment is "Waiting"

    @t:payment:Waiting:card_always:payer=owner
    Examples: Always pay on its card
      | act                                             |
      | the owner taps Always pay on the payment's card |

    @t:payment:Waiting:card_never:payer=owner
    Examples: Never pay on its card
      | act                                            |
      | the owner taps Never pay on the payment's card |

    @t:payment:Waiting:always_committed:payer=owner
    Examples: an Always committed elsewhere
      | act                                                        |
      | an Always for the payment's agent and recipient commits    |

    @t:payment:Waiting:deny_committed:payer=owner
    Examples: a Deny committed elsewhere
      | act                                         |
      | a Deny for the payment's recipient commits  |

  @UC-12 @H-106
  @t:payment:Queued:deny_committed:payer=owner
  Scenario: A Deny committed for agents leaves the owner's queued Send in the lane
    Given the payment is "Queued"
    And the payer is the owner
    When a Deny for the payment's recipient commits
    Then the payment is "Queued"

  @UC-03 @H-258 @H-261 @best
  @t:wallet:ready_saved:show_receive:!has_code
  Scenario: The owner opens Receive on a backed-up wallet
    Given the wallet is "ready_saved"
    And the wallet's address has no code
    When the owner opens Receive
    Then the wallet is "ready_saved"
    And the address leaves banda only after the key was saved or the step skipped

  # Finding 10, C17: when eth_getCode on the wallet's address returns code (an EIP-7702 delegation made elsewhere
  # with the exported key), Receive and its QR give way to a warning and the owner's Send waits for an
  # acknowledgement on the host; a paired device cannot acknowledge it. The owner's token on this computer counts as the
  # host for this act: a process holding it can already do every owner act (STEPS.md).
  @UC-03 @UC-07 @H-157 @security
  Scenario Outline: The address has code, so Receive warns instead of showing it, and only the host acknowledges it
    Given the wallet is "<state>"
    And the wallet's address has code
    When the owner opens Receive
    Then the wallet is "<state>"
    Given the reveal comes from a paired device or the token alone
    When the owner acknowledges the address's code
    Then the wallet is "<state>"
    Given the reveal comes from the host's desktop shell
    When the owner acknowledges the address's code
    Then the wallet is "<state>"

    @t:wallet:ready_saved:show_receive:has_code
    @t:wallet:ready_saved:acknowledge_code:has_code&cap_host
    @t:wallet:ready_saved:acknowledge_code:![has_code&cap_host]
    Examples: backed up
      | state       |
      | ready_saved |

    @t:wallet:ready_skipped:show_receive:has_code
    @t:wallet:ready_skipped:acknowledge_code:has_code&cap_host
    @t:wallet:ready_skipped:acknowledge_code:![has_code&cap_host]
    Examples: skipped
      | state         |
      | ready_skipped |

  # C17: an acknowledgement with no code to acknowledge is refused, on any client.
  @UC-03 @H-157 @error
  @t:wallet:ready_unsaved:acknowledge_code:![has_code&cap_host]
  @t:wallet:ready_unsaved:acknowledge_code:has_code&cap_host
  Scenario: An acknowledgement on a wallet whose key is not saved yet changes nothing
    Given the wallet is "ready_unsaved"
    And the wallet's address has no code
    And the reveal comes from the host's desktop shell
    When the owner acknowledges the address's code
    Then the wallet is "ready_unsaved"
    Given the wallet's address has code
    When the owner acknowledges the address's code
    Then the wallet is "ready_unsaved"
