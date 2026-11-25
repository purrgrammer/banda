# Machine: wallet (model/transitions.json). Use cases UC-01, UC-17, UC-18.
# Every outcome below is the table's; check_features.py replays each step and derives the @t tags.
# Evidence: spikes/keychain/README.md (write, read back and derive on macOS and Linux; a planted item is
# refused by the existence check), spikes/banda-integration/README.md (fault points wallet:reserved ... keychain:read).
# Run under features/ISOLATION.md: own temp home, in-memory keystore unless @keychain.

Feature: A wallet's life: create, archive, unarchive, remove

  @UC-01 @H-001 @H-006 @best
  @t:wallet:none:create:T
  @t:wallet:creating:keychain_write:kc_up&item=empty
  @t:wallet:creating:read_back:kc_up&item=ours
  Scenario: A wallet is created, its key written to the keychain and read back
    Given the wallet is "none"
    And the keychain answers
    And the keychain holds no item for the address
    When the owner creates a wallet
    Then the wallet is "creating"
    When the signer writes the key to the keychain
    Then the wallet is "creating"
    Given the keychain item derives the wallet's address
    When the signer reads the key back
    Then the wallet is "ready_unsaved"
    And a ready wallet always has its key
    And the key is never in the store or the box

  # keychain spike: an unanswered prompt blocks the call; the signer child is killed at its deadline (C20).
  @UC-01 @UC-19 @H-018 @error
  @t:wallet:creating:keychain_write:!kc_up
  @t:wallet:creating:read_back:!kc_up
  Scenario: The keychain does not answer during creation, and the wallet waits in creating
    Given the wallet is "creating"
    And the keychain does not answer
    When the signer writes the key to the keychain
    Then the wallet is "creating"
    When the signer reads the key back
    Then the wallet is "creating"
    And a ready wallet always has its key

  # keychain spike: the existence check before the write refuses a pre-existing item; nothing is overwritten.
  # Evidence: spikes/gaps/README.md §H: the orphan listing is findCredentials(service) of @napi-rs/keyring 2.1.2:
  # exact service match, and it returns every secret, so it runs in the signer child and only accounts leave it.
  @UC-01 @H-024 @security
  @t:wallet:creating:keychain_write:kc_up&item!=empty
  Scenario: An item already under the wallet's account drops the record and overwrites nothing
    Given the wallet is "creating"
    And the keychain answers
    And the keychain item holds another key
    When the signer writes the key to the keychain
    Then the wallet is "dropped"
    And no keychain item is left without a record

  @UC-01 @H-006 @error
  Scenario Outline: A read-back that does not return the wallet's key drops the record
    Given the wallet is "creating"
    And the keychain answers
    And <item>
    When the signer reads the key back
    Then the wallet is "dropped"
    And a ready wallet always has its key

    @t:wallet:creating:read_back:kc_up&item!=ours
    Examples:
      | item                                       |
      | the keychain item holds another key        |
      | the keychain holds no item for the address |

  # Evidence: spikes/gaps/README.md §A: a balance set with anvil_setBalance shows at safe only after N + 1 mined
  # blocks.
  @UC-17 @H-042 @best
  @t:wallet:ready_saved:archive:version_current
  @t:wallet:archived:unarchive:version_current&saved
  Scenario: The owner archives a saved wallet that holds funds and brings it back
    Given the wallet is "ready_saved"
    And the wallet holds funds at safe
    And the owner confirmed the key saved
    And the owner's wallet act carries the current version
    When the owner archives the wallet
    Then the wallet is "archived"
    When the owner unarchives the wallet
    Then the wallet is "ready_saved"
    And banda never destroys the only copy of a funded wallet's key

  @UC-17 @H-042
  Scenario Outline: Archive works from every ready state
    Given the wallet is "<state>"
    And the owner's wallet act carries the current version
    When the owner archives the wallet
    Then the wallet is "archived"

    @t:wallet:ready_unsaved:archive:version_current
    Examples: not backed up
      | state         |
      | ready_unsaved |

    @t:wallet:ready_skipped:archive:version_current
    Examples: skipped
      | state         |
      | ready_skipped |

  # C8: an owner act carries the version it saw; a stale one is refused and the screen redraws.
  @UC-17 @H-050 @race
  Scenario Outline: An archive sent from a screen that is out of date changes nothing
    Given the wallet is "<state>"
    And the owner's wallet act carries a stale version
    When the owner archives the wallet
    Then the wallet is "<state>"
    And no act applies on a version it did not see

    @t:wallet:ready_unsaved:archive:!version_current
    Examples: not backed up
      | state         |
      | ready_unsaved |

    @t:wallet:ready_saved:archive:!version_current
    Examples: backed up
      | state       |
      | ready_saved |

    @t:wallet:ready_skipped:archive:!version_current
    Examples: skipped
      | state         |
      | ready_skipped |

  @UC-17 @H-042
  @t:wallet:archived:unarchive:version_current&!saved
  Scenario: Unarchiving a wallet whose key was never confirmed saved keeps it marked Not backed up
    Given the wallet is "archived"
    And the owner never confirmed the key saved
    And the owner's wallet act carries the current version
    When the owner unarchives the wallet
    Then the wallet is "ready_skipped"

  @UC-17 @H-050 @race
  @t:wallet:archived:unarchive:!version_current
  Scenario: An unarchive from an out-of-date screen changes nothing
    Given the wallet is "archived"
    And the owner's wallet act carries a stale version
    When the owner unarchives the wallet
    Then the wallet is "archived"

  # Evidence: spikes/gaps/README.md §H: findCredentials after a delete no longer lists the item (macOS and Linux).
  @UC-18 @H-043 @best
  @t:wallet:ready_saved:begin_remove:version_current&removable
  @t:wallet:removing:delete_item:kc_up&item=ours&removable
  @t:wallet:removing:item_gone:T
  Scenario: An empty wallet with nothing in flight is removed and its keychain item deleted
    Given the wallet is "ready_saved"
    And the owner's wallet act carries the current version
    And the wallet holds nothing at safe
    And the wallet has nothing in flight
    And the wallet's address has left banda
    And the owner confirmed the key saved
    And the keychain answers
    And the keychain item derives the wallet's address
    When the owner removes the wallet
    Then the wallet is "removing"
    When the signer deletes the keychain item
    Then the wallet is "removing"
    When the keychain reports the item gone
    Then the wallet is "removed"
    And banda never destroys the only copy of a funded wallet's key
    And no keychain item is left without a record

  @UC-18 @H-043
  Scenario Outline: A removable wallet starts its removal from any state that allows it
    Given the wallet is "<state>"
    And the owner's wallet act carries the current version
    And the wallet holds nothing at safe
    And the wallet has nothing in flight
    And the wallet's address never left banda
    And the owner never confirmed the key saved
    When the owner removes the wallet
    Then the wallet is "removing"

    @t:wallet:ready_unsaved:begin_remove:version_current&removable
    Examples: never shown, not backed up
      | state         |
      | ready_unsaved |

    @t:wallet:ready_skipped:begin_remove:version_current&removable
    Examples: skipped
      | state         |
      | ready_skipped |

    @t:wallet:archived:begin_remove:version_current&removable
    Examples: archived
      | state    |
      | archived |

  # C17: removal is refused while funds or work in flight remain, or a disclosed address's key was never saved.
  # Evidence: spikes/gaps/README.md §A: 'funds at safe' needs N + 1 blocks mined after anvil_setBalance.
  @UC-18 @H-043 @security
  Scenario Outline: Removal is refused while the wallet holds funds or work, or its shown key was never saved
    Given the wallet is "<state>"
    And <version>
    And <funds>
    And <inflight>
    And <shown>
    And <saved>
    When the owner removes the wallet
    Then the wallet is "<state>"
    And banda never destroys the only copy of a funded wallet's key

    @t:wallet:ready_unsaved:begin_remove:![version_current&removable]
    Examples: another device changed the wallet first
      | state         | version                                             | funds                           | inflight                                        | shown                          | saved                                   |
      | ready_unsaved | the owner's wallet act carries a stale version      | the wallet holds nothing at safe | the wallet has nothing in flight                | the wallet's address never left banda | the owner never confirmed the key saved |

    @t:wallet:ready_saved:begin_remove:![version_current&removable]
    Examples: funds at safe
      | state       | version                                             | funds                           | inflight                                        | shown                          | saved                                   |
      | ready_saved | the owner's wallet act carries the current version  | the wallet holds funds at safe   | the wallet has nothing in flight                | the wallet's address has left banda | the owner confirmed the key saved       |
      | ready_saved | the owner's wallet act carries a stale version      | the wallet holds nothing at safe | the wallet has nothing in flight                | the wallet's address has left banda | the owner confirmed the key saved       |

    @t:wallet:ready_skipped:begin_remove:![version_current&removable]
    Examples: a payment in flight
      | state         | version                                             | funds                           | inflight                                        | shown                          | saved                                   |
      | ready_skipped | the owner's wallet act carries the current version  | the wallet holds nothing at safe | the wallet has a payment or authorization in flight | the wallet's address never left banda    | the owner never confirmed the key saved |

    @t:wallet:archived:begin_remove:![version_current&removable]
    Examples: archived with funds
      | state    | version                                             | funds                           | inflight                                        | shown                          | saved                                   |
      | archived | the owner's wallet act carries the current version  | the wallet holds funds at safe   | the wallet has nothing in flight                | the wallet's address never left banda        | the owner never confirmed the key saved |

  # C17: the delete re-checks; funds that arrived after the removal began cancel it and archive the wallet.
  # Evidence: spikes/gaps/README.md §A: funds arriving are visible at safe N + 1 blocks after they were set.
  @UC-18 @H-046 @race
  @t:wallet:removing:delete_item:kc_up&item=ours&!removable
  Scenario: Funds that arrive while removing cancel the removal and archive the wallet
    Given the wallet is "removing"
    And the keychain answers
    And the keychain item derives the wallet's address
    And the wallet holds funds at safe
    And the wallet has nothing in flight
    And the wallet's address never left banda
    When the signer deletes the keychain item
    Then the wallet is "archived"
    And banda never destroys the only copy of a funded wallet's key

  # H-045: the item under the wallet's account holds a key that does not derive its address (planted, or put back by
  # hand). Its address was never checked for funds, so the item is never deleted. The wallet's own key is gone already,
  # so the removal ends; the item stays, listed as a key without a wallet.
  @UC-18 @H-045 @security
  @t:wallet:removing:delete_item:kc_up&item=other
  Scenario: The keychain item holds another key at the delete, and the removal ends with that key kept
    Given the wallet is "removing"
    And the keychain answers
    And the keychain item holds another key
    When the signer deletes the keychain item
    Then the wallet is "removed"
    And banda never deletes a key that does not open its wallet
    And no keychain item is left without a record

  # H-044: a stop after the delete leaves `removing` with no item. Nothing is left to delete or to protect, so the
  # removal ends whatever reached the address since: its key was saved, or it was never disclosed (C17).
  @UC-18 @H-044 @crash
  @t:wallet:removing:delete_item:kc_up&item=empty
  @t:wallet:removing:item_gone:T
  Scenario: A removal stopped after its delete ends once the keychain answers, even with funds at the address
    Given the wallet is "removing"
    And the keychain answers
    And the keychain holds no item for the address
    And the owner confirmed the key saved
    And the wallet holds funds at safe
    When the signer deletes the keychain item
    Then the wallet is "removing"
    When the keychain reports the item gone
    Then the wallet is "removed"
    And banda never destroys the only copy of a funded wallet's key
    And no keychain item is left without a record

  # Evidence: spikes/gaps/README.md §H: on Linux a locked collection makes findCredentials throw (IsLocked), so the
  # orphan check reports that it could not list, never 'no orphan'.
  @UC-18 @H-044 @error
  @t:wallet:removing:delete_item:!kc_up
  Scenario: The keychain does not answer at the delete, and removing holds until it does
    Given the wallet is "removing"
    And the keychain does not answer
    When the signer deletes the keychain item
    Then the wallet is "removing"
    And no keychain item is left without a record

  # C15, C17 (finding 14): an agent's wallet__address or wallet__balance discloses the address, so it answers only
  # after the save step; before it the tool says the owner has not saved the key yet.
  @UC-06 @UC-03 @H-005 @security
  Scenario Outline: An agent reads its wallet's address only after the owner saved the key or skipped the step
    Given the wallet is "<state>"
    When an agent reads the wallet's address
    Then the wallet is "<state>"
    And the address leaves banda only after the key was saved or the step skipped

    @t:wallet:ready_unsaved:agent_reads_address:T
    Examples: not saved yet: withheld
      | state         |
      | ready_unsaved |

    @t:wallet:ready_saved:agent_reads_address:T
    Examples: saved: answered
      | state       |
      | ready_saved |

    @t:wallet:ready_skipped:agent_reads_address:T
    Examples: skipped: answered
      | state         |
      | ready_skipped |

  # H-046: funds that reach an archived wallet stay visible in Settings, and the wallet cannot be removed while they
  # are there; unarchiving it is the way back to spending them.
  @UC-17 @H-046 @edge
  @t:wallet:archived:begin_remove:![version_current&removable]
  Scenario: Funds arrive at an archived wallet, and it cannot be removed while they are there
    Given the wallet is "archived"
    And the owner's wallet act carries the current version
    And the wallet holds funds at safe
    And the wallet has nothing in flight
    And the wallet's address has left banda
    And the owner confirmed the key saved
    When the owner removes the wallet
    Then the wallet is "archived"
    And banda never destroys the only copy of a funded wallet's key
