# Machine: payment (call with wallet_usable, cancel_or_switch_off). Use cases UC-05, UC-13.
# C3 step 1 and 2 (wallet usable, agent on) come first; C17 lifecycle gates refuse open asks and queued payments
# in the same commit that switches a wallet off; C13 past the burn point. Evidence:
# spikes/banda-integration/README.md (multiAccount listed every account; a rerun after a Deny reported
# "did not run" on banda's real effectRun, which C13 forbids for bytes that left).

Feature: The owner chooses which wallets an agent may use

  @UC-05 @H-051 @best
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=always&fits
  Scenario: A wallet switched on for an agent pays an Always recipient
    Given the payment is "Idle"
    And the wallet is usable by the payer
    And the payer is the agent
    And the payment's recipient is set to Always
    And the available balance covers the payment
    When the payment is requested
    Then the payment is "Queued"

  @UC-05 @H-053 @security
  Scenario Outline: A wallet that is not on for the payer, archived or offline refuses the call first
    Given the payment is "Idle"
    And the wallet is not usable by the payer
    And <payer>
    When the payment is requested
    Then the payment is "Refused"
    And a refused payment is never paid

    @t:payment:Idle:call:!wallet_usable
    Examples:
      | payer                 |
      | the payer is the agent |
      | the payer is the owner |

  @UC-05 @UC-13 @H-054 @race
  Scenario Outline: The wallet switched off for the agent refuses its open ask or queued payment in that commit
    Given the payment is "<state>"
    When the run is cancelled or the wallet is switched off for the payer
    Then the payment is "Refused"
    And a refused payment is never paid

    @t:payment:Waiting:cancel_or_switch_off:T
    Examples: an open ask
      | state   |
      | Waiting |

    @t:payment:Queued:cancel_or_switch_off:T
    Examples: a queued payment
      | state  |
      | Queued |

  @UC-13 @H-124 @H-126 @race
  Scenario Outline: The run cancelled past the burn point finishes, and the tool reports the lane's outcome
    Given the payment is "<state>"
    When the run is cancelled or the wallet is switched off for the payer
    Then the payment is "<state>"
    And what the chat is told matches the chain

    @t:payment:Signed:cancel_or_switch_off:T
    Examples: signed, may have sent
      | state  |
      | Signed |

    @t:payment:Sent:cancel_or_switch_off:T
    Examples: sent
      | state |
      | Sent  |

    @t:payment:Included:cancel_or_switch_off:T
    Examples: included
      | state    |
      | Included |

  @UC-13 @H-055 @edge
  @t:payment:Waiting:cancel_or_switch_off:T
  Scenario: An agent archived with a waiting payment takes its ask with it
    Given the payment is "Waiting"
    When the run is cancelled or the wallet is switched off for the payer
    Then the payment is "Refused"
