# Crash at every boundary: the daemon is killed (SIGKILL) at an effect boundary and restarted on the same home.
# Machines: wallet.restart, payment.crash, nonce.crash, x402.crash. Use cases UC-01, UC-11, UC-24, UC-27, UC-28.
# Each Examples block is one boundary; the fault point names come from spikes/banda-integration/README.md:
# wallet:reserved, wallet:signed, wallet:stored, wallet:broadcast, wallet:receipt, wallet:replace,
# challenge:observed, x402:signed, x402:sent, rule:set, keychain:read. Under test/fault/ each block is swept with one
# kill at its point (principle 10). Evidence: spikes/nonce-and-crash/README.md on anvil 1.9.0: 127 of 127 runs
# killed at every boundary paid exactly once.

Feature: A crash at any boundary resumes from the last commit

  # C15: a creating record is reconciled from the keychain at start; an item without a record is never adopted.
  # Evidence: spikes/gaps/README.md §H: findCredentials lists the scenario's own service only (exact match); on
  # macOS an item the process cannot read is left out, so a missing item is not proof of absence.
  @UC-01 @H-005 @H-045 @crash
  Scenario Outline: The daemon restarts while a wallet is being created
    Given the wallet is "creating"
    And <keychain>
    And <item>
    When the daemon restarts while the wallet is in that state
    Then the wallet is "<after>"
    And a ready wallet always has its key
    And no keychain item is left without a record

    @spike
    @t:wallet:creating:restart:kc_up&item=ours
    Examples: killed after the read-back's write, before the ready commit
      | keychain             | item                                           | after         |
      | the keychain answers | the keychain item derives the wallet's address | ready_unsaved |

    @t:wallet:creating:restart:kc_up&item!=ours
    Examples: killed before the write
      | keychain             | item                                       | after   |
      | the keychain answers | the keychain holds no item for the address | dropped |

    @t:wallet:creating:restart:!kc_up
    Examples: the keychain does not answer at start
      | keychain                     | item                                           | after    |
      | the keychain does not answer | the keychain item derives the wallet's address | creating |

  # H-045: an item of another key under the wallet's account is not the wallet's: the record is dropped, and the item
  # stays, listed as an orphan and never deleted.
  @UC-01 @H-045 @crash
  @t:wallet:creating:restart:kc_up&item!=ours
  Scenario: The daemon restarts while a wallet is being created, and the keychain item holds another key
    Given the wallet is "creating"
    And the keychain answers
    And the keychain item holds another key
    When the daemon restarts while the wallet is in that state
    Then the wallet is "dropped"
    And a ready wallet always has its key
    And banda never deletes a key that does not open its wallet

  @UC-11 @H-113 @H-114 @H-115 @H-116 @H-117 @H-119 @H-120 @H-121 @H-122 @crash @spike
  Scenario Outline: The daemon is killed with the payment at a boundary and resumes it from the last commit
    Given the payment is "<state>"
    When the daemon crashes and restarts with the payment in that state
    Then the payment is "<state>"
    And the payment is on chain at most once
    And no two payments share a nonce

    @t:payment:Idle:crash:T
    Examples: wallet:reserved, after admission, before the payment is queued
      | state |
      | Idle  |

    @t:payment:Waiting:crash:T
    Examples: killed while the Ask is open
      | state   |
      | Waiting |

    @t:payment:Queued:crash:T
    Examples: keychain:read or wallet:signed, before the start commit
      | state  |
      | Queued |

    @t:payment:Signed:crash:T
    Examples: wallet:stored, after the start commit, before the broadcast
      | state  |
      | Signed |

    @t:payment:Sent:crash:T
    Examples: wallet:broadcast or wallet:replace, after the broadcast or during a bump
      | state |
      | Sent  |

    @t:payment:Included:crash:T
    Examples: wallet:receipt, after the receipt was fetched
      | state    |
      | Included |

  # C4, C6: a payment killed before its start commit is signed again; nothing was burnt and no second nonce exists.
  @UC-11 @UC-28 @H-117 @H-033 @crash
  @t:payment:Queued:sign:T
  @t:payment:Queued:crash:T
  @t:payment:Queued:start_commit:!ledger_moved&wallet_usable&start_ok&fits
  Scenario: Killed after signing, before the start commit, the payment is signed again and lands once
    Given the payment is "Queued"
    And the payer is the agent
    And the payment's recipient is set to Always
    And the available balance covers the payment
    And the nonce ledger is as the signer read it
    When the signer signs the payment
    Then the payment is "Queued"
    When the daemon crashes and restarts with the payment in that state
    Then the payment is "Queued"
    When the signer signs the payment
    Then the payment is "Queued"
    Given the wallet is usable by the payer
    When the lane runs the start commit
    Then the payment is "Signed"
    And the payment is on chain at most once

  # C21: the start commit is synced before the broadcast; after a kill the committed bytes are rebroadcast.
  # Evidence: spikes/gaps/README.md §D: the rebroadcast is answered 'already known' (pending) or 'nonce too low'
  # (mined) on geth and reth.
  @UC-11 @H-119 @H-129 @crash
  @t:payment:Signed:crash:T
  @t:payment:Signed:broadcast:T
  @t:payment:Sent:receipt:blk=own|blk=own_cancel
  Scenario: Killed after the start commit, the stored bytes are rebroadcast and land once
    Given the payment is "Signed"
    And the receipt names a stored version of the payment
    When the daemon crashes and restarts with the payment in that state
    Then the payment is "Signed"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    When the lane reads the receipt at the payment's nonce
    Then the payment is "Included"
    And the payment is on chain at most once
    And what the chat is told matches the chain

  # C13, banda-integration spike: the rerun reports the lane's outcome, never "did not run" for bytes that left.
  @UC-11 @UC-13 @H-118 @H-126 @crash @race
  Scenario Outline: A start commit replayed on a payment already decided changes nothing
    Given the payment is "<state>"
    When the lane runs the start commit
    Then the payment is "<state>"
    And a refused payment is never paid

    @t:payment:Refused:start_commit:T
    Examples: refused while the signer held its bytes
      | state   |
      | Refused |

    @t:payment:NotPaid:start_commit:T
    Examples: the deadline passed first
      | state   |
      | NotPaid |

    @t:payment:Waiting:start_commit:T
    Examples: sent back to the owner
      | state   |
      | Waiting |

  @UC-11 @H-117 @H-119 @crash @spike
  Scenario Outline: The daemon is killed with the lane at a boundary
    Given the nonce lane is "<state>"
    When the daemon crashes and restarts with the nonce lane in that state
    Then the nonce lane is "<after>"
    And each lane effect is on chain at most once
    And the wallet's nonces have no gap

    @t:nonce:signing:crash:T
    Examples: killed while signing, before the start commit: nothing was burnt
      | state   | after |
      | signing | free  |

    @t:nonce:in_flight:crash:T
    Examples: killed after the start commit: the nonce stays in flight
      | state     | after     |
      | in_flight | in_flight |

  # Evidence: spikes/gaps/README.md §B: the x402 runs load a fixture built with the prestate tracer, with chain time
  # set to the wall clock after load.
  @UC-24 @H-234 @H-235 @crash
  Scenario Outline: The daemon is killed with an x402 payment at a boundary
    Given the x402 payment is "<state>"
    When the daemon crashes and restarts with the x402 payment in that state
    Then the x402 payment is "<state>"
    And an observation is settled at most once

    @t:x402:observed:crash:T
    Examples: challenge:observed, the observation committed
      | state    |
      | observed |

    @t:x402:waiting:crash:T
    Examples: waiting for the owner
      | state   |
      | waiting |

    @t:x402:authorizing:crash:T
    Examples: before the authorization commit
      | state       |
      | authorizing |

    @t:x402:authorized:crash:T
    Examples: x402:signed, committed, before the box got the header
      | state      |
      | authorized |

    @t:x402:handed:crash:T
    Examples: x402:sent, after the header reached the box
      | state  |
      | handed |

  # C23: lanes, the follower and the indexer start only after the migration step committed.
  @UC-27 @H-297 @H-291 @crash
  @t:payment:Signed:crash:T
  @t:payment:Signed:broadcast:T
  Scenario: After a migration killed midway, the lane resumes a signed payment from its stored bytes
    Given the payment is "Signed"
    When the daemon crashes and restarts with the payment in that state
    Then the payment is "Signed"
    When the lane broadcasts the stored bytes
    Then the payment is "Sent"
    And the payment is on chain at most once

  # C21: every version commit and every commit whose result is acknowledged or leaves the machine is synced before
  # that happens, so a power loss rolls the store back only to a state nobody was told and no byte left. Under
  # test/fault/ each Examples block runs on a filesystem that drops unsynced writes (LazyFS) at its boundary.
  # Evidence: PaymentLane_bug_C21, _bug_C21bump and _bug_C21acked (model/README.md) fail once a sync is left out.
  @UC-11 @H-119 @H-120 @crash
  Scenario Outline: The power fails with the payment at a boundary, and the restart finds what the last sync holds
    Given the payment is "<state>"
    When the power fails and the daemon restarts with the payment in that state
    Then the payment is "<state>"
    And the payment is on chain at most once
    And no two payments share a nonce
    And a refusal the owner was told is never undone

    @t:payment:Idle:power_loss:T
    Examples: before admission was acknowledged
      | state |
      | Idle  |

    @t:payment:Waiting:power_loss:T
    Examples: the card was drawn from a synced commit
      | state   |
      | Waiting |

    @t:payment:Queued:power_loss:T
    Examples: the queued payment was acknowledged to the chat
      | state  |
      | Queued |

    @t:payment:Signed:power_loss:T
    Examples: the start commit was synced before the broadcast
      | state  |
      | Signed |

    @t:payment:Sent:power_loss:T
    Examples: every version, the bump and the cancel included, was synced before it left
      | state |
      | Sent  |

    @t:payment:Included:power_loss:T
    Examples: the receipt is read again from the chain
      | state    |
      | Included |

  # C16, C5: a restored home holds no signing lease until the owner reviews it; a payment the backup held before its
  # burn point may have been paid since, so it is closed as Restored and never resumed; one past it is tracked again
  # from its stored versions. Evidence: PaymentLane_restore and PaymentLane_bug_C16 (model/README.md).
  @UC-21 @H-285 @crash
  Scenario Outline: The home is restored from a backup, and each payment resumes only from what cannot pay twice
    Given the payment is "<state>"
    When the home is restored from a backup taken with the payment in that state
    Then the payment is "<after>"
    And the payment is on chain at most once
    And no two payments share a nonce

    @t:payment:Waiting:restore_backup:T
    Examples: an open card in the backup
      | state   | after    |
      | Waiting | Restored |

    @t:payment:Queued:restore_backup:T
    Examples: a queued payment in the backup
      | state  | after    |
      | Queued | Restored |

    @t:payment:Idle:restore_backup:T
    Examples: nothing admitted yet
      | state | after |
      | Idle  | Idle  |

    @t:payment:Signed:restore_backup:T
    Examples: signed, its bytes stored
      | state  | after  |
      | Signed | Signed |

    @t:payment:Sent:restore_backup:T
    Examples: sent, its versions stored
      | state | after |
      | Sent  | Sent  |

    @t:payment:Included:restore_backup:T
    Examples: included in the backup, tracked again from Sent
      | state    | after |
      | Included | Sent  |

  # C21, C4: the lane's signing is in memory, so a power loss while signing leaves the nonce free; every other lane
  # state comes back from its synced commit. Evidence: NonceAlloc_bug_C21 and _bug_C21bump (model/README.md).
  @UC-11 @H-117 @crash
  Scenario Outline: The power fails with the nonce lane in each state
    Given the nonce lane is "<state>"
    When the power fails and the daemon restarts with the nonce lane in that state
    Then the nonce lane is "<after>"
    And no two payments share a nonce
    And the wallet's nonces have no gap

    @t:nonce:signing:power_loss:T
    Examples: signing in memory, nothing committed
      | state   | after |
      | signing | free  |

    @t:nonce:free:power_loss:T
    Examples: free
      | state | after |
      | free  | free  |

    @t:nonce:in_flight:power_loss:T
    Examples: in flight, the start commit synced
      | state     | after     |
      | in_flight | in_flight |

    @t:nonce:blocked:power_loss:T
    Examples: blocked, the block committed
      | state   | after   |
      | blocked | blocked |

  # C21: the authorization commit is synced before the header is handed, so the box never holds a header the store
  # forgot. Evidence: X402_bug_C21 and X402_nondurable (model/README.md).
  @UC-24 @UC-11 @H-235 @crash
  Scenario Outline: The power fails with the x402 payment in each state
    Given the x402 payment is "<state>"
    When the power fails and the daemon restarts with the x402 payment in that state
    Then the x402 payment is "<state>"
    And an observation is settled at most once
    And live authorizations never exceed the balance

    @t:x402:observed:power_loss:T
    Examples: observed
      | state    |
      | observed |

    @t:x402:waiting:power_loss:T
    Examples: waiting on the card
      | state   |
      | waiting |

    @t:x402:authorizing:power_loss:T
    Examples: answered, before the authorization commit
      | state       |
      | authorizing |

    @t:x402:authorized:power_loss:T
    Examples: committed and synced, before the header
      | state      |
      | authorized |

    @t:x402:handed:power_loss:T
    Examples: the header handed
      | state  |
      | handed |
