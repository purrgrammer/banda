# Machine: x402. Use cases UC-23, UC-24, UC-25, UC-29.
# R-5: the EIP-3009 nonce is derived from (wallet, observation id), so one observation can settle at most once.
# C18: an observation belongs to the chat whose request the proxy saw. C19: windows come from chain time
# (validBefore at most t + 60 s). C21: the authorization commit is durable before the header leaves.
# Evidence: spikes/x402-settlement/README.md on an anvil Base Sepolia fork: USDC allows one transfer per
# (payer, nonce) and checks validBefore strictly against block time; the reference SDK signs 10-year windows and
# offers approve(Permit2, max), so no x402 SDK is on the payer's path. spikes/banda-integration/README.md: an
# untrusted upstream gave 502 and no observation.
# spikes/gaps/README.md §F: the reference facilitator checks C19's window against its own wall clock (it refuses
# validBefore < now + 6 and validAfter > now), so the window passes only while chain time is 54 s behind to 5 s ahead
# of that clock, a narrower band than the 120 s skew pause; C19 anchors the window to both clocks for that reason. §B: the offline fixture is built with
# the prestate tracer, because a fork's anvil_dumpState drops the token's implementation and its library.

Feature: An agent pays an x402 endpoint the proxy observed

  # Evidence: spikes/gaps/README.md §B: on the offline fixture, settle gives status 1 with Transfer and
  # AuthorizationUsed, and authorizationState is true at latest at once, at safe after N blocks, at finalized after
  # 2N; §F: the reference facilitator accepts the window only while chain time is 54 s behind to 5 s ahead of its
  # wall clock.
  @UC-23 @UC-24 @UC-25 @H-216 @best
  @t:x402:none:proxy_sees_402:verified
  @t:x402:authorized:hand_header:synced
  @t:x402:handed:follow:event=used&event_fin
  @t:x402:authorizing:authorization_commit:eff!=deny&[eff=always|approved]&fits @t:x402:observed:call:same_chat&eff=always&fits
  Scenario: The proxy observes a 402, the agent pays it under Always, and the settlement is followed to finality
    Given the x402 payment is "none"
    And the 402 passes the proxy's checks
    And the call comes from the chat that observed the 402
    And the endpoint is set to Always
    And the available USDC covers the x402 payment
    And the authorization commit is durable
    And the chain shows AuthorizationUsed
    And that event is finalized
    When the proxy sees a 402 from the box's request
    Then the x402 payment is "observed"
    When the agent pays the observation
    Then the x402 payment is "authorizing"
    When the daemon runs the authorization commit
    Then the x402 payment is "authorized"
    When the daemon hands the header to the box
    Then the x402 payment is "handed"
    When the follower reads the authorization's state
    Then the x402 payment is "settled"
    And an observation is settled at most once
    And only observed terms are signed
    And what the chat is told about the x402 payment matches the chain
    And every authorization rests on Always or the owner's approval

  # x402 spike step 7: plain HTTP, x402 v1, another scheme, asset, network or token domain give no observation.
  @UC-23 @H-224 @H-231 @H-232 @security
  @t:x402:none:proxy_sees_402:!verified
  Scenario: A 402 that fails the proxy's checks makes no observation
    Given the x402 payment is "none"
    And the 402 fails the proxy's checks
    When the proxy sees a 402 from the box's request
    Then the x402 payment is "none"
    And only observed terms are signed

  @UC-23 @UC-24 @UC-29 @H-218 @H-060 @H-221 @security
  @t:x402:observed:call:!same_chat
  Scenario: Another chat cannot pay this chat's observation
    Given the x402 payment is "observed"
    And the call comes from another chat
    When the agent pays the observation
    Then the x402 payment is "observed"
    And only the observing chat pays its observation

  @UC-24 @H-216 @error
  @t:x402:observed:call:same_chat&eff=deny
  Scenario: An endpoint set to Deny is refused
    Given the x402 payment is "observed"
    And the call comes from the chat that observed the 402
    And the endpoint is set to Deny
    When the agent pays the observation
    Then the x402 payment is "refused"

  @UC-24 @H-239 @H-240 @error
  Scenario Outline: Not enough USDC after reservations refuses the x402 payment
    Given the x402 payment is "observed"
    And the call comes from the chat that observed the 402
    And <rule>
    And the available USDC does not cover the x402 payment
    When the agent pays the observation
    Then the x402 payment is "refused"
    And live authorizations never exceed the balance

    @t:x402:observed:call:same_chat&eff!=deny&!fits
    Examples:
      | rule                         |
      | the endpoint is set to Always |
      | the endpoint is set to Ask    |

  @UC-24 @H-216
  @t:x402:authorizing:authorization_commit:eff!=deny&[eff=always|approved]&fits @t:x402:observed:call:same_chat&eff=ask&fits
  @t:x402:waiting:card_pay:window_left&host_ok
  Scenario: An endpoint set to Ask waits for the owner, who taps Pay, and the authorization is committed
    Given the x402 payment is "observed"
    And the call comes from the chat that observed the 402
    And the endpoint is set to Ask
    And the available USDC covers the x402 payment
    And the observation can still be answered
    And the owner approved the x402 payment
    When the agent pays the observation
    Then the x402 payment is "waiting"
    Given the x402 answer comes from the host or the endpoint is known on the host
    When the owner taps Pay on the x402 card
    Then the x402 payment is "authorizing"
    When the daemon runs the authorization commit
    Then the x402 payment is "authorized"
    And every authorization rests on Always or the owner's approval

  @UC-24 @H-223
  @t:x402:waiting:card_always:window_left&host_ok
  Scenario: Always pay on the x402 card authorizes this observation
    Given the x402 payment is "waiting"
    And the observation can still be answered
    And the x402 answer comes from the host or the endpoint is known on the host
    When the owner taps Always pay on the x402 card
    Then the x402 payment is "authorizing"

  # C10: an Ask answered after the challenge can no longer be answered is Not paid.
  @UC-24 @H-241
  Scenario Outline: An x402 card answered too late is Not paid
    Given the x402 payment is "waiting"
    And the observation can no longer be answered
    When <answer>
    Then the x402 payment is "notpaid"

    @t:x402:waiting:card_pay:!window_left
    Examples: Pay
      | answer                              |
      | the owner taps Pay on the x402 card |

    @t:x402:waiting:card_always:!window_left
    Examples: Always pay
      | answer                                     |
      | the owner taps Always pay on the x402 card |

  @UC-24 @H-216
  Scenario Outline: The owner refuses an x402 payment on its card
    Given the x402 payment is "waiting"
    When <answer>
    Then the x402 payment is "refused"

    @t:x402:waiting:card_never:T
    Examples: Never pay
      | answer                                    |
      | the owner taps Never pay on the x402 card |

    @t:x402:waiting:card_dont_pay:T
    Examples: Don't pay
      | answer                                    |
      | the owner taps Don't pay on the x402 card |

  @UC-24 @H-241 @H-225
  Scenario Outline: The deadline passes before the authorization is committed
    Given the x402 payment is "<state>"
    When the x402 payment's deadline passes
    Then the x402 payment is "notpaid"

    @t:x402:waiting:deadline:T
    Examples: waiting for the owner
      | state   |
      | waiting |

    @t:x402:authorizing:deadline:T
    Examples: not yet committed
      | state       |
      | authorizing |

  # The authorization commit re-checks the rule, the approval and the balance before any signature (C4 for x402).
  @UC-24 @H-223 @race
  @t:x402:authorizing:authorization_commit:eff=deny
  Scenario: The endpoint was set to Deny before the authorization commit
    Given the x402 payment is "authorizing"
    And the endpoint is set to Deny
    When the daemon runs the authorization commit
    Then the x402 payment is "refused"

  @UC-24 @H-223 @race
  @t:x402:authorizing:authorization_commit:eff!=deny&eff!=always&!approved
  Scenario: Always was taken back to Ask before the commit, and the payment returns to the owner
    Given the x402 payment is "authorizing"
    And the endpoint is set to Ask
    And the x402 payment has no approval
    When the daemon runs the authorization commit
    Then the x402 payment is "waiting"

  @UC-24 @H-238 @race
  @t:x402:authorizing:authorization_commit:eff!=deny&[eff=always|approved]&!fits
  Scenario: Two parallel requests to one Always endpoint: the second commit finds no USDC left
    Given the x402 payment is "authorizing"
    And the endpoint is set to Always
    And the available USDC does not cover the x402 payment
    When the daemon runs the authorization commit
    Then the x402 payment is "refused"
    And live authorizations never exceed the balance

  # C21: the header leaves the daemon only after the authorization commit is durable.
  @UC-24 @H-234 @H-226
  @t:x402:authorized:hand_header:!synced
  @t:x402:authorized:hand_header:synced
  Scenario: The header waits until the authorization commit is durable
    Given the x402 payment is "authorized"
    And the authorization commit is not yet durable
    When the daemon hands the header to the box
    Then the x402 payment is "authorized"
    Given the authorization commit is durable
    When the daemon hands the header to the box
    Then the x402 payment is "handed"

  @UC-24 @H-227 @H-228 @race
  Scenario Outline: The agent pays the same observation again and gets the same authorization
    Given the x402 payment is "<state>"
    When the agent pays the same observation again
    Then the x402 payment is "<state>"
    And an observation is settled at most once

    @t:x402:authorized:agent_pays_again:T
    Examples: committed
      | state      |
      | authorized |

    @t:x402:handed:agent_pays_again:T
    Examples: handed to the box
      | state  |
      | handed |

  # Evidence: spikes/gaps/README.md §B: cancelAuthorization gives AuthorizationCanceled and authorizationState true,
  # and a settle after it is 'FiatTokenV2: authorization is used or canceled'.
  @UC-25 @H-251
  @t:x402:handed:follow:event=cancelled&event_fin
  Scenario: The exported key cancelled the authorization, and it is Cancelled at finality
    Given the x402 payment is "handed"
    And the chain shows AuthorizationCanceled
    And that event is finalized
    When the follower reads the authorization's state
    Then the x402 payment is "cancelled"
    And what the chat is told about the x402 payment matches the chain

  # Evidence: spikes/gaps/README.md §B: right after settle, authorizationState is true at latest and false at safe
  # and finalized until N and 2N more blocks are mined.
  @UC-25 @H-245 @H-249
  Scenario Outline: An event not yet finalized decides nothing
    Given the x402 payment is "handed"
    And <event>
    And that event is not finalized
    When the follower reads the authorization's state
    Then the x402 payment is "handed"
    And what the chat is told about the x402 payment matches the chain

    @t:x402:handed:follow:event!=none&!event_fin
    Examples:
      | event                                  |
      | the chain shows AuthorizationUsed      |
      | the chain shows AuthorizationCanceled  |

  # x402 spike: expiry is checked against block time, strictly; the reservation is released at Expired.
  # Evidence: spikes/gaps/README.md §B: at block time validBefore - 1 settle works; at validBefore it is
  # 'FiatTokenV2: authorization is expired', and a mined expired attempt leaves authorizationState false (the nonce
  # is never burnt).
  @UC-25 @H-237
  @t:x402:handed:follow:event=none&vb_passed_fin
  Scenario: No settlement before validBefore passed at finality, so the authorization Expired
    Given the x402 payment is "handed"
    And the chain shows no event for the authorization
    And validBefore has passed at finalized
    When the follower reads the authorization's state
    Then the x402 payment is "expired"
    And live authorizations never exceed the balance

  # Evidence: spikes/gaps/README.md §F: @x402/express 2.32.0 answers HTTP 402 with PAYMENT-RESPONSE success false,
  # errorReason settlement_pending and the transaction, after running the route's handler; the chain shows no event
  # until the next block; a retry of the header gets the same transaction, then
  # 'invalid_exact_evm_nonce_already_used' once settled, so the chat is told paid, not delivered.
  @UC-25 @H-236 @H-245
  @t:x402:handed:follow:event=none&!vb_passed_fin
  Scenario: The facilitator says settlement_pending, and the payment stays handed until the chain decides
    Given the x402 payment is "handed"
    And the chain shows no event for the authorization
    And validBefore has not passed at finalized
    When the follower reads the authorization's state
    Then the x402 payment is "handed"
    And what the chat is told about the x402 payment matches the chain

  # Finding 18, OD-13: the wallet's default for unknown recipients applies to x402 endpoints too. Under Deny an
  # unknown endpoint is refused with no card; under the default Ask it waits for the owner.
  @UC-24 @H-216 @error
  Scenario Outline: An unknown endpoint follows the wallet's default
    Given the x402 payment is "observed"
    And the call comes from the chat that observed the 402
    And the endpoint is unknown
    And <default>
    And the available USDC covers the x402 payment
    When the agent pays the observation
    Then the x402 payment is "<after>"
    And every authorization rests on Always or the owner's approval

    @t:x402:observed:call:same_chat&eff=deny
    Examples: default Deny
      | default                                            | after   |
      | the wallet's default for unknown endpoints is Deny | refused |

    @t:x402:observed:call:same_chat&eff=ask&fits
    Examples: default Ask
      | default                                           | after   |
      | the wallet's default for unknown endpoints is Ask | waiting |

  # Finding 3: a paired device's answer to the card of an endpoint new to the host becomes a host Wait.
  @UC-26 @H-277 @H-280 @security
  Scenario Outline: A paired device answers an x402 card for an endpoint new to the host, and it waits for the host
    Given the x402 payment is "waiting"
    And the observation can still be answered
    And the x402 answer comes from a paired device and the endpoint is new to the host
    When <answer>
    Then the x402 payment is "waiting"
    Given the x402 answer comes from the host or the endpoint is known on the host
    When <answer>
    Then the x402 payment is "authorizing"

    @t:x402:waiting:card_pay:window_left&!host_ok
    @t:x402:waiting:card_pay:window_left&host_ok
    Examples: Pay
      | answer                              |
      | the owner taps Pay on the x402 card |

    @t:x402:waiting:card_always:window_left&!host_ok
    @t:x402:waiting:card_always:window_left&host_ok
    Examples: Always pay
      | answer                                     |
      | the owner taps Always pay on the x402 card |
