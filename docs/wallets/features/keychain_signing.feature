# Machine: signing (and wallet.keychain_write for Linux). Use cases UC-04, UC-19, UC-20, UC-21, UC-22, UC-28.
# Evidence: spikes/keychain/README.md: on macOS the AbortSignal is ignored and four hung calls starve libuv
# (hence the killable signer child, C20); on Linux the default "auto" store fell back to the kernel keyring and
# lost keys at reboot (hence the store pinned to secret-service); 8 concurrent writes on Linux lost 7 keys (hence
# one keychain call at a time per home). C16: key proof, lease and home secret at every unlock.

Feature: The signer proves the key and the lease before it signs

  # Evidence: spikes/gaps/README.md §H: Linux only. With the collection locked, findCredentials throws 'IsLocked' in
  # 4 ms, and get, set and delete fail in 9 to 17 ms (spikes/keychain). A locked macOS keychain was not run: it needs a
  # prompt in front of the person or a change to the keychain search list.
  @UC-19 @UC-04 @H-026 @H-317 @best
  @t:signing:online:keychain_locks:T
  @t:signing:locked:unlock_check:derives&lease_mine&!host_mode
  Scenario: The keychain locks, the wallet shows one offline reason, and comes back online after the check
    Given the signer is "online"
    And the signer's key derives the wallet's address
    And this home holds the signing lease
    And the home runs commands in a box
    When the keychain locks
    Then the signer is "locked"
    When the signer checks the key
    Then the signer is "online"
    And banda never signs with a key that does not derive the address
    And only one home signs for the wallet

  @UC-19 @H-021 @H-290
  @t:signing:online:item_lost:T
  @t:signing:key_missing:restore_key:derives
  Scenario: The keychain item disappears and the owner restores the exported key
    Given the signer is "online"
    And the signer's key derives the wallet's address
    When the keychain item disappears
    Then the signer is "key_missing"
    When the owner restores the key
    Then the signer is "online"
    And banda never signs with a key that does not derive the address

  # H-317: a lock or a loss seen while the wallet is already offline replaces the reason it shows; only a restore
  # leaves key_missing (C9, H-290).
  @UC-19 @UC-04 @H-026 @H-317
  Scenario Outline: The keychain locks while the wallet is offline for another reason, and it shows the lock
    Given the signer is "<from>"
    When the keychain locks
    Then the signer is "locked"

    @t:signing:locked:keychain_locks:T
    Examples: already locked
      | from   |
      | locked |

    @t:signing:wrong_key:keychain_locks:T
    Examples: another key
      | from      |
      | wrong_key |

    @t:signing:other_home:keychain_locks:T
    Examples: another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:keychain_locks:T
    Examples: host mode
      | from              |
      | offline_host_mode |

  @UC-19 @UC-04 @H-021 @H-317
  Scenario Outline: The keychain item disappears while the wallet is offline for another reason, and it shows the key missing
    Given the signer is "<from>"
    When the keychain item disappears
    Then the signer is "key_missing"

    @t:signing:locked:item_lost:T
    Examples: locked
      | from   |
      | locked |

    @t:signing:wrong_key:item_lost:T
    Examples: another key
      | from      |
      | wrong_key |

    @t:signing:other_home:item_lost:T
    Examples: another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:item_lost:T
    Examples: host mode
      | from              |
      | offline_host_mode |

    @t:signing:key_missing:item_lost:T
    Examples: already missing
      | from        |
      | key_missing |

  @UC-19 @UC-04 @H-290 @H-317
  @t:signing:key_missing:keychain_locks:T
  Scenario: The keychain locks while the key is missing, and the wallet stays key missing until a restore
    Given the signer is "key_missing"
    When the keychain locks
    Then the signer is "key_missing"

  # OD-6: Restore key accepts only a key that derives the record's address; there is no import.
  @UC-19 @H-014 @security
  @t:signing:key_missing:restore_key:!derives
  Scenario: Restore key with a key that opens another address leaves the wallet offline
    Given the signer is "key_missing"
    And the signer's key derives another address
    When the owner restores the key
    Then the signer is "key_missing"
    And banda never signs with a key that does not derive the address

  @UC-19 @H-026
  Scenario Outline: A check that proves the key and the lease, in a box, brings the wallet online
    Given the signer is "<from>"
    And the signer's key derives the wallet's address
    And this home holds the signing lease
    And the home runs commands in a box
    When the signer checks the key
    Then the signer is "online"

    @t:signing:online:unlock_check:derives&lease_mine&!host_mode
    Examples: online
      | from   |
      | online |

    @t:signing:locked:unlock_check:derives&lease_mine&!host_mode
    Examples: was locked
      | from   |
      | locked |

    @t:signing:wrong_key:unlock_check:derives&lease_mine&!host_mode
    Examples: was wrong key
      | from      |
      | wrong_key |

    @t:signing:other_home:unlock_check:derives&lease_mine&!host_mode
    Examples: was another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:unlock_check:derives&lease_mine&!host_mode
    Examples: was host mode
      | from              |
      | offline_host_mode |

  @UC-19 @H-025 @security
  Scenario Outline: A keychain key that does not derive the address takes the wallet offline as wrong key
    Given the signer is "<from>"
    And the signer's key derives another address
    When the signer checks the key
    Then the signer is "wrong_key"
    And banda never signs with a key that does not derive the address

    @t:signing:online:unlock_check:!derives
    Examples: online
      | from   |
      | online |

    @t:signing:locked:unlock_check:!derives
    Examples: locked
      | from   |
      | locked |

    @t:signing:wrong_key:unlock_check:!derives
    Examples: wrong key
      | from      |
      | wrong_key |

    @t:signing:other_home:unlock_check:!derives
    Examples: another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:unlock_check:!derives
    Examples: host mode
      | from              |
      | offline_host_mode |

  # R-12: the home whose home secret matches the keychain's lease signs; a restored backup or a fork does not.
  @UC-21 @H-020 @H-284 @security
  Scenario Outline: Another home holds the lease, and this one stays offline
    Given the signer is "<from>"
    And the signer's key derives the wallet's address
    And another home holds the signing lease
    When the signer checks the key
    Then the signer is "other_home"
    And only one home signs for the wallet

    @t:signing:online:unlock_check:derives&!lease_mine
    Examples: online
      | from   |
      | online |

    @t:signing:locked:unlock_check:derives&!lease_mine
    Examples: locked
      | from   |
      | locked |

    @t:signing:wrong_key:unlock_check:derives&!lease_mine
    Examples: wrong key
      | from      |
      | wrong_key |

    @t:signing:other_home:unlock_check:derives&!lease_mine
    Examples: another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:unlock_check:derives&!lease_mine
    Examples: host mode
      | from              |
      | offline_host_mode |

  @UC-22 @H-064 @H-065 @security
  Scenario Outline: Host mode takes the wallet offline
    Given the signer is "<from>"
    And the signer's key derives the wallet's address
    And this home holds the signing lease
    And the home runs commands on the host
    When the signer checks the key
    Then the signer is "offline_host_mode"
    And banda never signs with a key that does not derive the address

    @t:signing:online:unlock_check:derives&lease_mine&host_mode
    Examples: online
      | from   |
      | online |

    @t:signing:locked:unlock_check:derives&lease_mine&host_mode
    Examples: locked
      | from   |
      | locked |

    @t:signing:wrong_key:unlock_check:derives&lease_mine&host_mode
    Examples: wrong key
      | from      |
      | wrong_key |

    @t:signing:other_home:unlock_check:derives&lease_mine&host_mode
    Examples: another home
      | from       |
      | other_home |

    @t:signing:offline_host_mode:unlock_check:derives&lease_mine&host_mode
    Examples: host mode
      | from              |
      | offline_host_mode |

  @UC-21 @H-289 @race
  @t:signing:other_home:lease_moved:lease_mine
  Scenario: The owner moves the lease to this home, and it signs again
    Given the signer is "other_home"
    And this home holds the signing lease
    When the signing lease moves
    Then the signer is "online"
    And only one home signs for the wallet

  @UC-21 @H-284 @H-283 @security
  @t:signing:online:lease_moved:!lease_mine
  Scenario: The lease moves to another home, and this one stops signing
    Given the signer is "online"
    And another home holds the signing lease
    When the signing lease moves
    Then the signer is "other_home"
    And only one home signs for the wallet

  @UC-21 @H-287
  Scenario Outline: A lease move that leaves this home where it was changes nothing
    Given the signer is "<from>"
    And <lease>
    When the signing lease moves
    Then the signer is "<from>"

    @t:signing:online:lease_moved:lease_mine
    Examples: still the signing home
      | from   | lease                             |
      | online | this home holds the signing lease |

    @t:signing:other_home:lease_moved:!lease_mine
    Examples: still another home
      | from       | lease                                |
      | other_home | another home holds the signing lease |

  # keychain spike, Linux: no Secret Service, no session bus or no default collection fails the write with a
  # classified message; the key is never stored in the kernel keyring.
  @UC-20 @H-029 @H-028 @keychain @spike
  @t:wallet:creating:keychain_write:!kc_up
  Scenario: On Linux without a usable Secret Service the wallet stays in creating
    Given the wallet is "creating"
    And the keychain does not answer
    When the signer writes the key to the keychain
    Then the wallet is "creating"
    And a ready wallet always has its key

  @UC-28 @H-009 @security
  @t:signing:locked:unlock_check:derives&lease_mine&!host_mode
  Scenario: The signer signs only after it proved the key in this home
    Given the signer is "locked"
    And the signer's key derives the wallet's address
    And this home holds the signing lease
    And the home runs commands in a box
    When the signer checks the key
    Then the signer is "online"
    And the key is never in the store or the box
