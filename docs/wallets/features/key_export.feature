# Machine: wallet (reveal, confirm_saved, skip_save, show_receive). Use cases UC-02, UC-03, UC-26, UC-29, UC-30.
# Evidence: spikes/keys-and-signing/README.md (a raw 0x + 64 hex key, imported by MetaMask and cast; 2000 keys
# round-trip), RFC resolution R-8 and OD-2 (the key is shown on the host only, behind OS re-authentication and a
# one-time capability; "saved" is confirmed by pasting the key back).
# spikes/gaps/README.md §G: on macOS the OS re-authentication is Electron's promptTouchID (Touch ID, or the password
# where there is none; read from source and Apple's docs, not run); Electron has none for Linux (open).

Feature: The owner saves the private key, and Receive opens after the save step

  # Evidence: spikes/gaps/README.md §G: Electron 45.2.3's systemPreferences.promptTouchID uses
  # kSecAccessControlUserPresence (Touch ID, or the password where there is none), macOS only; there is no Electron
  # API for Linux, so the host capability is open there.
  @UC-02 @UC-03 @H-263 @H-258 @best
  @t:wallet:ready_unsaved:reveal:cap_host&cap_fresh&kc_up&item=ours
  @t:wallet:ready_unsaved:confirm_saved:pasted_derives
  @t:wallet:ready_saved:show_receive:!has_code
  Scenario: The owner reveals the key on the host, pastes it back, and Receive opens
    Given the wallet is "ready_unsaved"
    And the reveal comes from the host's desktop shell
    And the reveal capability is fresh and unused
    And the keychain answers
    And the keychain item derives the wallet's address
    And the pasted key derives the wallet's address
    When the owner asks to reveal the key
    Then the wallet is "ready_unsaved"
    When the owner pastes the key back
    Then the wallet is "ready_saved"
    Given the wallet's address has no code
    When the owner opens Receive
    Then the wallet is "ready_saved"
    And the key is revealed only on the host
    And a reveal capability is used once
    And the address leaves banda only after the key was saved or the step skipped

  # Evidence: spikes/gaps/README.md §G: the same macOS-only prompt; not run.
  @UC-02 @H-266
  Scenario Outline: A later reveal on the host follows the same capability path
    Given the wallet is "<state>"
    And the reveal comes from the host's desktop shell
    And the reveal capability is fresh and unused
    And the keychain answers
    And the keychain item derives the wallet's address
    When the owner asks to reveal the key
    Then the wallet is "<state>"
    And the key is revealed only on the host

    @t:wallet:ready_saved:reveal:cap_host&cap_fresh&kc_up&item=ours
    Examples: backed up
      | state       |
      | ready_saved |

    @t:wallet:ready_skipped:reveal:cap_host&cap_fresh&kc_up&item=ours
    Examples: skipped
      | state         |
      | ready_skipped |

  # OD-2: a paired device, a browser device or a local process holding the owner's token never sees a key.
  @UC-02 @UC-26 @H-264 @H-267 @security
  Scenario Outline: A reveal asked from a paired device or with the token alone shows nothing
    Given the wallet is "<state>"
    And the reveal comes from a paired device or the token alone
    When the owner asks to reveal the key
    Then the wallet is "<state>"
    And the key is revealed only on the host
    And the key is never in the store or the box

    @t:wallet:ready_unsaved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
    Examples: not backed up
      | state         |
      | ready_unsaved |

    @t:wallet:ready_saved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
    Examples: backed up
      | state       |
      | ready_saved |

    @t:wallet:ready_skipped:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
    Examples: skipped
      | state         |
      | ready_skipped |

  @UC-02 @H-268 @security
  @t:wallet:ready_saved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
  Scenario: A replayed or expired reveal capability shows nothing
    Given the wallet is "ready_saved"
    And the reveal comes from the host's desktop shell
    And the reveal capability is used or expired
    When the owner asks to reveal the key
    Then the wallet is "ready_saved"
    And a reveal capability is used once

  @UC-02 @UC-19 @H-021 @H-025 @error
  Scenario Outline: No reveal when the keychain cannot answer or holds another key
    Given the wallet is "ready_unsaved"
    And the reveal comes from the host's desktop shell
    And the reveal capability is fresh and unused
    And <keychain>
    And <item>
    When the owner asks to reveal the key
    Then the wallet is "ready_unsaved"
    And banda never signs with a key that does not derive the address

    @t:wallet:ready_unsaved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
    Examples:
      | keychain                      | item                                            |
      | the keychain does not answer  | the keychain item derives the wallet's address  |
      | the keychain answers          | the keychain item holds another key             |
      | the keychain answers          | the keychain holds no item for the address      |

  @UC-02 @H-275 @error
  @t:wallet:ready_unsaved:confirm_saved:!pasted_derives
  Scenario: A pasted key that does not open the wallet leaves it Not backed up
    Given the wallet is "ready_unsaved"
    And the pasted key does not derive the wallet's address
    When the owner pastes the key back
    Then the wallet is "ready_unsaved"

  @UC-02 @UC-03 @H-273
  @t:wallet:ready_unsaved:skip_save:T
  @t:wallet:ready_skipped:show_receive:!has_code
  Scenario: The owner skips saving the key, and Receive opens with the wallet marked Not backed up
    Given the wallet is "ready_unsaved"
    When the owner skips saving the key
    Then the wallet is "ready_skipped"
    Given the wallet's address has no code
    When the owner opens Receive
    Then the wallet is "ready_skipped"
    And the address leaves banda only after the key was saved or the step skipped

  @UC-03 @H-005 @edge
  @t:wallet:ready_unsaved:show_receive:T
  Scenario: Receive asked while the save step is open shows the save step instead
    Given the wallet is "ready_unsaved"
    When the owner opens Receive
    Then the wallet is "ready_unsaved"
    And the address leaves banda only after the key was saved or the step skipped

  @UC-26 @H-276 @edge
  @t:wallet:ready_unsaved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
  @t:wallet:ready_unsaved:skip_save:T
  Scenario: A wallet created from a paired phone stays Not backed up until the host shows its key
    Given the wallet is "ready_unsaved"
    And the reveal comes from a paired device or the token alone
    When the owner asks to reveal the key
    Then the wallet is "ready_unsaved"
    When the owner skips saving the key
    Then the wallet is "ready_skipped"

  # UC-29: a page or the agent asks for the key; no tool returns it, and no reveal path exists outside the host.
  @UC-29 @H-265 @security
  @t:wallet:ready_saved:reveal:![cap_host&cap_fresh]|!kc_up|item!=ours
  Scenario: A page that steers the agent to ask for the key gets nothing
    Given the wallet is "ready_saved"
    And the reveal comes from a paired device or the token alone
    And the reveal capability is used or expired
    When the owner asks to reveal the key
    Then the wallet is "ready_saved"
    And the key is never in the store or the box

  # UC-30: logs, activity and the public repo never carry the key; a log scan runs after this flow.
  @UC-30 @H-300 @security
  @t:wallet:ready_skipped:reveal:cap_host&cap_fresh&kc_up&item=ours
  Scenario: A reveal leaves no key in logs, activity or the store
    Given the wallet is "ready_skipped"
    And the reveal comes from the host's desktop shell
    And the reveal capability is fresh and unused
    And the keychain answers
    And the keychain item derives the wallet's address
    When the owner asks to reveal the key
    Then the wallet is "ready_skipped"
    And the key is never in the store or the box

  # Finding 31, C16: requirement 5 holds where no OS re-authentication exists (a Linux desktop, `banda serve` with a
  # loopback browser, `banda wallet create` on the host's terminal). The ready commit mints a creation capability
  # for the create request id, consumed once within 10 minutes by the client that sent it, before the address is
  # shown; every later reveal needs the host's capability.
  @UC-02 @H-263 @H-266 @best
  @t:wallet:ready_unsaved:reveal:cap_host&cap_fresh&kc_up&item=ours
  @t:wallet:ready_unsaved:confirm_saved:pasted_derives
  Scenario: The client that created the wallet reveals its key once at creation, with no OS re-authentication
    Given the wallet is "ready_unsaved"
    And the reveal comes from the client that created the wallet
    And the reveal capability is fresh and unused
    And the keychain answers
    And the keychain item derives the wallet's address
    And the pasted key derives the wallet's address
    When the owner asks to reveal the key
    Then the wallet is "ready_unsaved"
    And a reveal capability is used once
    And the key is never in the store or the box
    When the owner pastes the key back
    Then the wallet is "ready_saved"
