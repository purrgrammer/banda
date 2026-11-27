# Machine: payment (and recipient where a card answer sets the rule). Use cases UC-07, UC-08, UC-09, UC-10, UC-13.
# Admission follows C3's fixed order; the start commit is the burn point (C4); states move forward on chain
# evidence only (C12). Evidence: spikes/nonce-and-crash/README.md on anvil 1.9.0 (127 of 127 crash runs paid once;
# a rebroadcast of stored bytes is harmless; status 0 is the only failure), spikes/banda-integration/README.md
# (Always maps to a permission of scope always binding {account, chain, to}; Deny lives in `allowed`).

Feature: An agent pays an address, and the owner answers when asked

  # Evidence: spikes/gaps/README.md §A: 'that block is finalized' is 2N blocks mined after it on anvil 1.9.0
  # (finalized = latest - 2N).
  @UC-07 @UC-10 @H-074 @H-112 @best
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=always&fits
  @t:payment:Queued:sign:T
  @t:payment:Signed:broadcast:T
  @t:payment:Included:finality:blk_fin&blk!=own_cancel&blk_ok @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits @t:payment:Sent:receipt:blk=own|blk=own_cancel
  Scenario: An agent pays a recipient set to Always, and it lands exactly once
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Always
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    And the receipt names a stored version of the payment
    And that block is finalized
    And the receipt's status is 1
    When the payment is requested
    Then the payment is "Queued"
    When the signer signs the payment
    Then the payment is "Queued"
    When the lane runs the start commit
    Then the payment is "Signed"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    When the payment's block reaches finality
    Then the payment is "Confirmed"
    And the payment is on chain at most once
    And what the chat is told matches the chain
    And every start rests on Always, a fresh approval or the owner as payer

  @UC-07 @UC-08 @H-073 @H-075 @H-096 @H-097 @best
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=ask&fits
  @t:recipient:unknown:card_pay:version_current
  @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
  Scenario: The first payment to an unknown recipient asks, the owner taps Pay, and the rule becomes Ask
    Given the payment is "Idle"
    And the recipient is "unknown"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is unknown
    And the wallet's default for unknown recipients is Ask
    And the available balance covers the payment
    And the owner's recipient act carries the current version
    When the payment is requested
    Then the payment is "Waiting"
    Given the answer comes from the host or the recipient is known on the host
    When the owner taps Pay on the payment's card
    And the recipient takes the card answer Pay
    Then the payment is "Queued"
    And the recipient is "ask"
    And an unknown recipient is never Always

  @UC-07 @H-075
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=ask&fits
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
  Scenario: A known recipient set to Ask asks again, and a fresh approval lets the start commit sign
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Ask
    And the available balance covers the payment
    And the owner's approval of the payment is fresh
    And the nonce ledger is as the signer read it
    When the payment is requested
    Then the payment is "Waiting"
    Given the answer comes from the host or the recipient is known on the host
    When the owner taps Pay on the payment's card
    Then the payment is "Queued"
    When the lane runs the start commit
    Then the payment is "Signed"
    And every start rests on Always, a fresh approval or the owner as payer

  @UC-07 @H-076 @error
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=deny
  Scenario: A payment to a recipient set to Deny is refused in words, with no card
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Deny
    When the payment is requested
    Then the payment is "Refused"
    And a Deny refuses every later call to its recipient
    And a refused payment is never paid

  @UC-09 @H-090 @error
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=deny
  Scenario: Under the default Deny, an unknown recipient is refused with no card
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is unknown
    And the wallet's default for unknown recipients is Deny
    When the payment is requested
    Then the payment is "Refused"

  # OD-8: a payment the available balance (after reservations and fees, C11) cannot cover is refused, no card.
  # Evidence: spikes/gaps/README.md §E: on Base the balance falls by value + gasUsed x effectiveGasPrice + l1Fee (23
  # of 24 senders checked), so the reserve's L1 term matters; a plain anvil charges no L1 fee, and a fork or -n base
  # charges one no receipt shows.
  @UC-07 @H-132 @H-134 @error
  Scenario Outline: A payment the available balance does not cover is refused before any card
    Given the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And <rule>
    And the wallet's default for unknown recipients is Ask
    And the available balance does not cover the payment
    When the payment is requested
    Then the payment is "Refused"
    And the wallet never spends more than was funded

    @t:payment:Idle:call:wallet_usable&payer=agent&eff!=deny&!fits
    Examples:
      | rule                                       |
      | the payment's recipient is set to Always   |
      | the payment's recipient is set to Ask      |
      | the payment's recipient is unknown         |

  @UC-08 @H-083 @H-091 @best
  @t:recipient:unknown:card_always:version_current
  @t:permission:none:card_always:version_current&rcpt!=deny
  @t:payment:Waiting:card_always:payer=agent&host_ok
  Scenario: Always pay on the card queues this payment, names the recipient and grants this agent Always
    Given the payment is "Waiting"
    And the recipient is "unknown"
    And the agent's permission for the recipient is "none"
    And the payer is the agent
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    And the recipient is unknown when the act commits
    And the answer comes from the host or the recipient is known on the host
    When the owner taps Always pay on the payment's card
    Then the payment is "Queued"
    When the recipient takes the card answer Always pay
    Then the recipient is "ask"
    When the agent's permission takes the card answer Always pay
    Then the agent's permission for the recipient is "always"
    And an Always covers only the agent it was granted to

  @UC-08 @H-084
  @t:payment:Waiting:card_never:payer=agent
  @t:recipient:ask:card_never:version_current
  Scenario: Never pay on the card refuses the payment and sets Deny for the wallet
    Given the payment is "Waiting"
    And the recipient is "ask"
    And the payer is the agent
    And the owner's recipient act carries the current version
    When the owner taps Never pay on the payment's card
    And the recipient takes the card answer Never pay
    Then the payment is "Refused"
    And the recipient is "deny"
    And a Deny holds for every agent of the wallet

  @UC-08 @H-073
  @t:payment:Waiting:card_dont_pay:T
  @t:recipient:unknown:card_dont_pay:version_current
  Scenario: Don't pay on the card refuses this payment and the rule becomes Ask
    Given the payment is "Waiting"
    And the recipient is "unknown"
    And the owner's recipient act carries the current version
    When the owner taps Don't pay on the payment's card
    And the recipient takes the card answer Don't pay
    Then the payment is "Refused"
    And the recipient is "ask"

  # C4 and C9: Deny wins over a later Pay tap; the answer covers only what it covers.
  @UC-08 @H-082 @race
  @t:payment:Waiting:card_pay:payer=agent&rule=deny
  Scenario: The rule became Deny while the card waited, so the owner's Pay is refused
    Given the payment is "Waiting"
    And the payer is the agent
    And the payment's recipient is set to Deny
    When the owner taps Pay on the payment's card
    Then the payment is "Refused"
    And a Deny refuses every later call to its recipient

  @UC-09 @H-084 @race
  Scenario Outline: A Deny for the recipient refuses the agent's open ask or queued payment in its commit
    Given the payment is "<state>"
    And the payer is the agent
    When a Deny for the payment's recipient commits
    Then the payment is "Refused"
    And a refused payment is never paid

    @t:payment:Waiting:deny_committed:payer=agent
    Examples: an open ask
      | state   |
      | Waiting |

    @t:payment:Queued:deny_committed:payer=agent
    Examples: a queued payment
      | state  |
      | Queued |

  # C13: past the burn point the lane owns the outcome; the payment finishes and is reported as it lands.
  @UC-09 @H-085 @race
  Scenario Outline: A Deny set after the start commit does not stop bytes that may have left
    Given the payment is "<state>"
    When a Deny for the payment's recipient commits
    Then the payment is "<state>"
    And what the chat is told matches the chain

    @t:payment:Signed:deny_committed:T
    Examples: signed
      | state  |
      | Signed |

    @t:payment:Sent:deny_committed:T
    Examples: sent
      | state |
      | Sent  |

    @t:payment:Included:deny_committed:T
    Examples: included
      | state    |
      | Included |

  @UC-08 @H-083 @race
  @t:payment:Waiting:always_committed:payer=agent
  Scenario: An Always committed on another card queues this agent's open ask for the same recipient
    Given the payment is "Waiting"
    And the payer is the agent
    When an Always for the payment's agent and recipient commits
    Then the payment is "Queued"

  # C10: an unanswered ask has a 24 h deadline; a routine at night meets "Not paid: no answer".
  @UC-13 @H-310 @H-142
  Scenario Outline: Nobody answers, and the deadline turns the payment into Not paid
    Given the payment is "<state>"
    When the payment's deadline passes
    Then the payment is "NotPaid"
    And a refused payment is never paid

    @t:payment:Waiting:deadline:T
    Examples: an open ask
      | state   |
      | Waiting |

    @t:payment:Queued:deadline:T
    Examples: approved and held in the lane
      | state  |
      | Queued |

  @UC-10 @UC-09 @H-086 @race
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&payer=agent&eff=deny
  Scenario: The start commit re-checks and finds the recipient now set to Deny
    Given the payment is "Queued"
    And the payer is the agent
    And the payment's recipient is set to Deny
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Refused"
    And a refused payment is never paid

  # C10: an approval older than 1 h, or Always taken back, sends the payment back to the owner; nothing burnt.
  @UC-10 @UC-13 @UC-09 @H-144 @H-087
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&![payer=agent&eff=deny]&!start_ok
  Scenario: The approval went stale in the lane, and the start commit asks the owner again
    Given the payment is "Queued"
    And the payer is the agent
    And the payment's recipient is set to Ask
    And the payment has no fresh approval
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Waiting"
    And every start rests on Always, a fresh approval or the owner as payer

  @UC-10 @H-133 @error
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&!fits
  Scenario: The balance dropped between approval and the start commit, and the payment is refused
    Given the payment is "Queued"
    And the payer is the agent
    And the payment's recipient is set to Always
    And the available balance does not cover the payment
    And the nonce ledger is as the signer read it
    And the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Refused"
    And the wallet never spends more than was funded

  # F-3: the start commit takes nonce = ledger with compare-and-set; bytes signed on an old ledger are dropped.
  @UC-10 @H-164 @race
  @t:payment:Queued:start_commit:ledger_moved
  Scenario: The ledger moved since signing, so the bytes are dropped and the payment is signed again
    Given the payment is "Queued"
    And the nonce ledger moved since signing
    When the lane runs the start commit
    Then the payment is "Queued"
    And no two payments share a nonce

  # Evidence: spikes/gaps/README.md §D: geth 1.17.10 and reth 2.10.1 accept +10% on both fees and refuse +9%, a
  # tip-only and a cap-only bump ('replacement transaction underpriced'), so +12.5% on both holds. Neither refuses a
  # fee cap below the base fee (anvil does), so 'the base fee rose' is read from the chain, never from a pool error.
  @UC-10 @H-172 @H-175
  @t:payment:Sent:bump:T
  @t:payment:Sent:receipt:blk=own|blk=own_cancel
  Scenario: The base fee rose, the lane bumps, and whichever stored version lands settles the payment
    Given the payment is "Sent"
    And the receipt names a stored version of the payment
    When the lane bumps the fee
    Then the payment is "Sent"
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    And the payment is on chain at most once

  # nonce-and-crash spike section 2: a rebroadcast of the same bytes is answered "already known" or "nonce too low".
  # Evidence: spikes/gaps/README.md §D: verbatim, a pending rebroadcast is 'already known' on geth and reth
  # ('transaction already imported' on anvil); a mined one is 'nonce too low: next nonce 1, tx nonce 0'. Codes
  # differ (reth -32003 for funds, -32000 otherwise), so messages decide.
  @UC-10 @H-179 @H-180 @H-184
  @t:payment:Sent:receipt:blk=none
  @t:payment:Sent:broadcast:T
  Scenario: Nothing holds the nonce yet, so the lane rebroadcasts its stored bytes
    Given the payment is "Sent"
    And no transaction holds the payment's nonce yet
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Sent"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    And the payment is on chain at most once

  # Evidence: spikes/gaps/README.md §A: the reorged transaction is not returned to anvil's pool; the rebroadcast of
  # the stored bytes gives the same hash.
  @UC-10 @H-181 @H-176
  @t:payment:Included:reorg:T
  @t:payment:Sent:receipt:blk=own|blk=own_cancel
  Scenario: A reorg removes the block, the payment goes back to Sent, and its bytes land again
    Given the payment is "Included"
    And the receipt names a stored version of the payment
    When a reorg removes the payment's block
    Then the payment is "Sent"
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    And the payment moves only along the table's edges

  # Evidence: spikes/gaps/README.md §A (finalized = latest - 2N on anvil) and §C (Base: about 1063 s on Sepolia and
  # 1175 s on mainnet behind latest).
  @UC-10 @H-189 @H-188
  @t:payment:Included:finality:!blk_fin
  Scenario: An included payment stays Included until its block is finalized
    Given the payment is "Included"
    And that block is not finalized
    When the payment's block reaches finality
    Then the payment is "Included"
    And what the chat is told matches the chain

  @UC-10 @H-147 @error
  @t:payment:Included:finality:blk_fin&blk!=own_cancel&!blk_ok&verified
  Scenario: A payment mined with status 0 is Failed
    Given the payment is "Included"
    And that block is finalized
    And the receipt's status is 0
    And the RPC's claim is proven
    And the receipt names a stored version of the payment
    When the payment's block reaches finality
    Then the payment is "Failed"
    And what the chat is told matches the chain

  # C7: a foreign transaction at the payment's nonce waits for finality before anything is decided.
  # Evidence: spikes/gaps/README.md §A and §D: 'nonce too low' answers both a mined own version and a foreign one,
  # so only the receipts of the stored versions tell them apart.
  @UC-15 @H-167 @race
  @t:payment:Sent:receipt:blk=foreign&!blk_fin
  @t:payment:Sent:receipt:blk=foreign&blk_fin&verified
  Scenario: A foreign transaction takes the payment's nonce, and the payment asks again only at finality
    Given the payment is "Sent"
    And a foreign transaction holds the payment's nonce
    And that block is not finalized
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Sent"
    Given that block is finalized
    And the RPC's claim is proven
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Waiting"
    And the payment is on chain at most once
    And the ledger is raised only at finalized

  @UC-26 @H-280
  @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
  Scenario: A paired phone answers Pay on a card for a recipient set to Ask
    Given the payment is "Waiting"
    And the payer is the agent
    And the payment's recipient is set to Ask
    And the answer comes from the host or the recipient is known on the host
    When the owner taps Pay on the payment's card
    Then the payment is "Queued"

  # Finding 3: a paired device's answer to a card whose recipient has no rule set on the host, and was never paid
  # from it, does not queue the payment; it becomes a host Wait, and the card stays open until the desktop app
  # answers it. A stolen unlocked phone pays only recipients the host already knows.
  @UC-26 @H-277 @H-278 @H-280 @security
  Scenario Outline: A paired device answers a card for a recipient new to the host, and the payment waits for the host
    Given the payment is "Waiting"
    And the payer is the agent
    And the payment's recipient is unknown
    And the answer comes from a paired device and the recipient is new to the host
    When <answer>
    Then the payment is "Waiting"
    Given the answer comes from the host or the recipient is known on the host
    When <answer>
    Then the payment is "Queued"
    And a refused payment is never paid

    @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&!host_ok
    @t:payment:Waiting:card_pay:![payer=agent&rule=deny]&host_ok
    Examples: Pay
      | answer                                  |
      | the owner taps Pay on the payment's card |

    @t:payment:Waiting:card_always:payer=agent&!host_ok
    @t:payment:Waiting:card_always:payer=agent&host_ok
    Examples: Always pay
      | answer                                         |
      | the owner taps Always pay on the payment's card |

  # C3 steps 1, 2, 3 and 6: the start commit re-reads the wallet; archived, switched off for the agent, the tool off
  # or the signer offline since the payment was queued refuses it in that commit, before anything is signed.
  # Evidence: PaymentLane_access and PaymentLane_bug_C4access (model/README.md).
  @UC-13 @UC-05 @H-047 @H-054 @error
  @t:payment:Queued:start_commit:!ledger_moved&!wallet_usable
  Scenario: The wallet was archived after the payment was queued, and the start commit refuses it
    Given the payment is "Queued"
    And the nonce ledger is as the signer read it
    And the wallet is not usable by the payer
    When the lane runs the start commit
    Then the payment is "Refused"
    And a refused payment is never paid
    And an Always payment never asks
