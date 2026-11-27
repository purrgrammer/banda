# Machines: recipient (per wallet and identity: unknown, ask, deny, with the owner's label) and permission (per wallet,
# agent and identity: none, always). Use cases UC-08, UC-09.
# OD-1: Deny and the label are the wallet's, for every agent; Always is one agent's permission. C8: every owner act
# carries the version it saw. C9: an answer covers what it covers. C18: a rule binds an identity, never a label.
# Evidence: spikes/banda-integration/README.md (Always = a permission of scope always over {account, chain, to};
# Deny in `allowed`); model/RecipientRule.tla (the two machines, PermissionUnderRecipient).

Feature: Recipients, their refusals and names, and each agent's permission

  @UC-08 @H-073 @best
  Scenario Outline: A card answer names a recipient seen for the first time
    Given the recipient is "unknown"
    And the owner's recipient act carries the current version
    When <answer>
    Then the recipient is "<rule>"
    And an unknown recipient is never Always

    @t:recipient:unknown:card_pay:version_current
    Examples: Pay
      | answer                                  | rule |
      | the recipient takes the card answer Pay | ask  |

    @t:recipient:unknown:card_always:version_current
    Examples: Always pay names it; the permission is the agent's
      | answer                                         | rule |
      | the recipient takes the card answer Always pay | ask  |

    @t:recipient:unknown:card_dont_pay:version_current
    Examples: Don't pay
      | answer                                        | rule |
      | the recipient takes the card answer Don't pay | ask  |

    @t:recipient:unknown:card_never:version_current
    Examples: Never pay
      | answer                                        | rule |
      | the recipient takes the card answer Never pay | deny |

  @UC-08 @H-075 @H-311
  Scenario Outline: A card answer for a recipient set to Ask
    Given the recipient is "ask"
    And the owner's recipient act carries the current version
    When <answer>
    Then the recipient is "<rule>"

    @t:recipient:ask:card_pay:version_current
    Examples: Pay keeps Ask
      | answer                                  | rule |
      | the recipient takes the card answer Pay | ask  |

    @t:recipient:ask:card_always:version_current
    Examples: Always pay in the morning keeps the recipient at Ask
      | answer                                         | rule |
      | the recipient takes the card answer Always pay | ask  |

    @t:recipient:ask:card_dont_pay:version_current
    Examples: Don't pay keeps Ask
      | answer                                        | rule |
      | the recipient takes the card answer Don't pay | ask  |

    @t:recipient:ask:card_never:version_current
    Examples: Never pay
      | answer                                        | rule |
      | the recipient takes the card answer Never pay | deny |

  # C4, C9: a card answered after Deny committed leaves the Deny; only a list act takes Deny back.
  @UC-08 @H-082 @race
  Scenario Outline: A card answered after the recipient was set to Deny leaves the Deny
    Given the recipient is "deny"
    And the owner's recipient act carries the current version
    When <answer>
    Then the recipient is "deny"
    And a Deny excludes every Always for that recipient

    @t:recipient:deny:card_pay:version_current
    Examples: Pay
      | answer                                  |
      | the recipient takes the card answer Pay |

    @t:recipient:deny:card_always:version_current
    Examples: Always pay
      | answer                                         |
      | the recipient takes the card answer Always pay |

    @t:recipient:deny:card_dont_pay:version_current
    Examples: Don't pay
      | answer                                        |
      | the recipient takes the card answer Don't pay |

    @t:recipient:deny:card_never:version_current
    Examples: Never pay
      | answer                                        |
      | the recipient takes the card answer Never pay |

  # C8: the same card answered on the phone and on the desktop; the second answer carries a stale version.
  @UC-08 @H-141 @race
  Scenario Outline: A card answer from a second device carries a stale version and changes nothing
    Given the recipient is "<rule>"
    And the owner's recipient act carries a stale version
    When <answer>
    Then the recipient is "<rule>"
    And no act applies on a version it did not see

    @t:recipient:unknown:card_pay:!version_current
    Examples: Pay on unknown
      | rule    | answer                                  |
      | unknown | the recipient takes the card answer Pay |

    @t:recipient:ask:card_pay:!version_current
    Examples: Pay on ask
      | rule | answer                                  |
      | ask  | the recipient takes the card answer Pay |

    @t:recipient:deny:card_pay:!version_current
    Examples: Pay on deny
      | rule | answer                                  |
      | deny | the recipient takes the card answer Pay |

    @t:recipient:unknown:card_always:!version_current
    Examples: Always pay on unknown
      | rule    | answer                                         |
      | unknown | the recipient takes the card answer Always pay |

    @t:recipient:ask:card_always:!version_current
    Examples: Always pay on ask
      | rule | answer                                         |
      | ask  | the recipient takes the card answer Always pay |

    @t:recipient:deny:card_always:!version_current
    Examples: Always pay on deny
      | rule | answer                                         |
      | deny | the recipient takes the card answer Always pay |

    @t:recipient:unknown:card_dont_pay:!version_current
    Examples: Don't pay on unknown
      | rule    | answer                                        |
      | unknown | the recipient takes the card answer Don't pay |

    @t:recipient:ask:card_dont_pay:!version_current
    Examples: Don't pay on ask
      | rule | answer                                        |
      | ask  | the recipient takes the card answer Don't pay |

    @t:recipient:deny:card_dont_pay:!version_current
    Examples: Don't pay on deny
      | rule | answer                                        |
      | deny | the recipient takes the card answer Don't pay |

    @t:recipient:unknown:card_never:!version_current
    Examples: Never pay on unknown
      | rule    | answer                                        |
      | unknown | the recipient takes the card answer Never pay |

    @t:recipient:ask:card_never:!version_current
    Examples: Never pay on ask
      | rule | answer                                        |
      | ask  | the recipient takes the card answer Never pay |

    @t:recipient:deny:card_never:!version_current
    Examples: Never pay on deny
      | rule | answer                                        |
      | deny | the recipient takes the card answer Never pay |

  @UC-09 @H-081 @best
  Scenario Outline: The owner changes a recipient's rule in the Recipients list
    Given the recipient is "<from>"
    And the owner's recipient act carries the current version
    When <act>
    Then the recipient is "<to>"
    And a Deny excludes every Always for that recipient

    @t:recipient:ask:list_set_ask:version_current
    Examples: Ask to Ask
      | from | act                                             | to  |
      | ask  | the owner sets the recipient to Ask in the list | ask |

    @t:recipient:deny:list_set_ask:version_current
    Examples: Deny back to Ask
      | from | act                                             | to  |
      | deny | the owner sets the recipient to Ask in the list | ask |

    @t:recipient:ask:list_set_always:version_current
    Examples: Always for one agent leaves the recipient at Ask
      | from | act                                                | to  |
      | ask  | the owner sets the recipient to Always in the list | ask |

    @t:recipient:deny:list_set_always:version_current
    Examples: Always is not granted over a Deny
      | from | act                                                | to   |
      | deny | the owner sets the recipient to Always in the list | deny |

    @t:recipient:ask:list_set_deny:version_current
    Examples: Ask to Deny
      | from | act                                              | to   |
      | ask  | the owner sets the recipient to Deny in the list | deny |

    @t:recipient:deny:list_set_deny:version_current
    Examples: Deny to Deny
      | from | act                                              | to   |
      | deny | the owner sets the recipient to Deny in the list | deny |

  @UC-09 @H-109 @race
  Scenario Outline: A list change from an out-of-date screen changes nothing
    Given the recipient is "<rule>"
    And the owner's recipient act carries a stale version
    When <act>
    Then the recipient is "<rule>"
    And no act applies on a version it did not see

    @t:recipient:ask:list_set_ask:!version_current
    Examples: Ask on ask
      | rule | act                                             |
      | ask  | the owner sets the recipient to Ask in the list |

    @t:recipient:deny:list_set_ask:!version_current
    Examples: Ask on deny
      | rule | act                                             |
      | deny | the owner sets the recipient to Ask in the list |

    @t:recipient:ask:list_set_always:!version_current
    Examples: Always on ask
      | rule | act                                                |
      | ask  | the owner sets the recipient to Always in the list |

    @t:recipient:deny:list_set_always:!version_current
    Examples: Always on deny
      | rule | act                                                |
      | deny | the owner sets the recipient to Always in the list |

    @t:recipient:ask:list_set_deny:!version_current
    Examples: Deny on ask
      | rule | act                                              |
      | ask  | the owner sets the recipient to Deny in the list |

    @t:recipient:deny:list_set_deny:!version_current
    Examples: Deny on deny
      | rule | act                                              |
      | deny | the owner sets the recipient to Deny in the list |

  # An unknown recipient has no list row; a list act names a recipient that exists (or that a stale screen showed).
  @UC-09 @H-089 @edge
  Scenario Outline: A list act on a recipient that is not in the list sets nothing
    Given the recipient is "unknown"
    When <act>
    Then the recipient is "unknown"
    And an unknown recipient is never Always

    @t:recipient:unknown:list_set_ask:T
    Examples: set Ask
      | act                                             |
      | the owner sets the recipient to Ask in the list |

    @t:recipient:unknown:list_set_always:T
    Examples: set Always
      | act                                                |
      | the owner sets the recipient to Always in the list |

    @t:recipient:unknown:list_set_deny:T
    Examples: set Deny
      | act                                              |
      | the owner sets the recipient to Deny in the list |

    @t:recipient:unknown:rename:T
    Examples: rename
      | act                          |
      | the owner renames the recipient |

    @t:recipient:unknown:forget:T
    Examples: forget
      | act                             |
      | the owner forgets the recipient |

  @UC-09 @H-080 @H-077 @best
  Scenario Outline: A rename keeps the recipient's rule
    Given the recipient is "<rule>"
    And the owner's recipient act carries the current version
    When the owner renames the recipient
    Then the recipient is "<rule>"
    And a rename keeps the recipient's rule
    And admission is decided by identity, never by label

    @t:recipient:ask:rename:version_current
    Examples: Ask
      | rule |
      | ask  |

    @t:recipient:deny:rename:version_current
    Examples: Deny
      | rule |
      | deny |

  @UC-09 @H-109 @race
  Scenario Outline: A rename from an out-of-date screen changes nothing
    Given the recipient is "<rule>"
    And the owner's recipient act carries a stale version
    When the owner renames the recipient
    Then the recipient is "<rule>"

    @t:recipient:ask:rename:!version_current
    Examples: Ask
      | rule |
      | ask  |

    @t:recipient:deny:rename:!version_current
    Examples: Deny
      | rule |
      | deny |

  @UC-09 @H-089 @H-088
  Scenario Outline: Forgetting a recipient returns it to unknown, so its next payment asks
    Given the recipient is "<rule>"
    And the owner's recipient act carries the current version
    When the owner forgets the recipient
    Then the recipient is "unknown"
    And an unknown recipient is never Always

    @t:recipient:ask:forget:version_current
    Examples: Ask
      | rule |
      | ask  |

    @t:recipient:deny:forget:version_current
    Examples: Deny
      | rule |
      | deny |

  @UC-09 @H-109 @race
  Scenario Outline: A forget from an out-of-date screen changes nothing
    Given the recipient is "<rule>"
    And the owner's recipient act carries a stale version
    When the owner forgets the recipient
    Then the recipient is "<rule>"

    @t:recipient:ask:forget:!version_current
    Examples: Ask
      | rule |
      | ask  |

    @t:recipient:deny:forget:!version_current
    Examples: Deny
      | rule |
      | deny |

  # ---------------------------------------------------------------- one agent's permission

  @UC-08 @H-083 @H-091 @best
  Scenario Outline: Always pay on a card grants this agent's permission on a recipient that is not denied
    Given the agent's permission for the recipient is "<from>"
    And <recipient>
    And the owner's permission act carries the current version
    When the agent's permission takes the card answer Always pay
    Then the agent's permission for the recipient is "always"
    And a permission lives only under a known recipient that is not denied
    And an Always covers only the agent it was granted to

    @t:permission:none:card_always:version_current&rcpt!=deny
    Examples: the first Always for this agent
      | from | recipient                                       |
      | none | the recipient is unknown when the act commits   |
      | none | the recipient is set to Ask when the act commits |

    @t:permission:always:card_always:version_current&rcpt!=deny
    Examples: again, from the morning's card
      | from   | recipient                                        |
      | always | the recipient is set to Ask when the act commits |

  @UC-08 @H-084 @race
  @t:permission:none:card_always:version_current&![rcpt!=deny]
  Scenario: Always pay is never granted over a Deny that committed first
    Given the agent's permission for the recipient is "none"
    And the recipient is set to Deny when the act commits
    And the owner's permission act carries the current version
    When the agent's permission takes the card answer Always pay
    Then the agent's permission for the recipient is "none"
    And a Deny excludes every Always for that recipient

  @UC-09 @H-081 @best
  Scenario Outline: The list's Always grants this agent's permission only on a recipient set to Ask
    Given the agent's permission for the recipient is "<from>"
    And <recipient>
    And the owner's permission act carries the current version
    When the agent's permission takes the list's Always
    Then the agent's permission for the recipient is "<to>"
    And a permission lives only under a known recipient that is not denied

    @t:permission:none:list_set_always:version_current&rcpt=ask
    Examples: granted
      | from | recipient                                        | to     |
      | none | the recipient is set to Ask when the act commits | always |

    @t:permission:always:list_set_always:version_current&rcpt=ask
    Examples: already granted
      | from   | recipient                                        | to     |
      | always | the recipient is set to Ask when the act commits | always |

    @t:permission:none:list_set_always:version_current&![rcpt=ask]
    Examples: refused on an unknown or denied recipient
      | from | recipient                                         | to   |
      | none | the recipient is unknown when the act commits     | none |
      | none | the recipient is set to Deny when the act commits | none |

  @UC-09 @H-084 @H-088 @best
  Scenario Outline: A Deny, an Ask in the list or a forget takes every agent's Always back in the same commit
    Given the agent's permission for the recipient is "<from>"
    And the owner's permission act carries the current version
    When <act>
    Then the agent's permission for the recipient is "none"
    And a Deny excludes every Always for that recipient

    @t:permission:always:card_never:version_current
    Examples: Never pay on another agent's card
      | from   | act                                                    |
      | always | the agent's permission takes the card answer Never pay |

    @t:permission:none:card_never:version_current
    Examples: Never pay with no permission
      | from | act                                                    |
      | none | the agent's permission takes the card answer Never pay |

    @t:permission:always:list_set_deny:version_current
    Examples: the list's Deny
      | from   | act                                       |
      | always | the agent's permission takes the list's Deny |

    @t:permission:none:list_set_deny:version_current
    Examples: the list's Deny with no permission
      | from | act                                          |
      | none | the agent's permission takes the list's Deny |

    @t:permission:always:list_set_ask:version_current
    Examples: the list's Ask
      | from   | act                                         |
      | always | the agent's permission takes the list's Ask |

    @t:permission:none:list_set_ask:version_current
    Examples: the list's Ask with no permission
      | from | act                                         |
      | none | the agent's permission takes the list's Ask |

    @t:permission:always:forget:version_current
    Examples: forget
      | from   | act                                    |
      | always | the agent's permission takes the forget |

    @t:permission:none:forget:version_current
    Examples: forget with no permission
      | from | act                                     |
      | none | the agent's permission takes the forget |

  @UC-09 @H-109 @race
  Scenario Outline: A permission act from an out-of-date screen changes nothing
    Given the agent's permission for the recipient is "<state>"
    And the owner's permission act carries a stale version
    When <act>
    Then the agent's permission for the recipient is "<state>"
    And no act applies on a version it did not see

    @t:permission:none:card_always:!version_current
    Examples: Always pay on none
      | state | act                                                     |
      | none  | the agent's permission takes the card answer Always pay |

    @t:permission:always:card_always:!version_current
    Examples: Always pay on always
      | state  | act                                                     |
      | always | the agent's permission takes the card answer Always pay |

    @t:permission:none:list_set_always:!version_current
    Examples: the list's Always on none
      | state | act                                            |
      | none  | the agent's permission takes the list's Always |

    @t:permission:always:list_set_always:!version_current
    Examples: the list's Always on always
      | state  | act                                            |
      | always | the agent's permission takes the list's Always |

    @t:permission:none:card_never:!version_current
    Examples: Never pay on none
      | state | act                                                    |
      | none  | the agent's permission takes the card answer Never pay |

    @t:permission:always:card_never:!version_current
    Examples: Never pay on always
      | state  | act                                                    |
      | always | the agent's permission takes the card answer Never pay |

    @t:permission:none:list_set_deny:!version_current
    Examples: the list's Deny on none
      | state | act                                          |
      | none  | the agent's permission takes the list's Deny |

    @t:permission:always:list_set_deny:!version_current
    Examples: the list's Deny on always
      | state  | act                                          |
      | always | the agent's permission takes the list's Deny |

    @t:permission:none:list_set_ask:!version_current
    Examples: the list's Ask on none
      | state | act                                         |
      | none  | the agent's permission takes the list's Ask |

    @t:permission:always:list_set_ask:!version_current
    Examples: the list's Ask on always
      | state  | act                                         |
      | always | the agent's permission takes the list's Ask |

    @t:permission:none:forget:!version_current
    Examples: forget on none
      | state | act                                     |
      | none  | the agent's permission takes the forget |

    @t:permission:always:forget:!version_current
    Examples: forget on always
      | state  | act                                     |
      | always | the agent's permission takes the forget |

  @UC-09 @H-080 @H-077
  Scenario Outline: A rename keeps every agent's permission
    Given the agent's permission for the recipient is "<state>"
    When the agent's permission takes the rename
    Then the agent's permission for the recipient is "<state>"
    And a rename keeps the recipient's rule

    @t:permission:none:rename:T
    Examples: none
      | state |
      | none  |

    @t:permission:always:rename:T
    Examples: always
      | state  |
      | always |

  # OD-1 on a shared wallet: the Deny is the recipient's, and the same commit takes this agent's Always (and every
  # other agent's, each its own permission machine).
  @UC-09 @H-081 @H-084 @race
  @t:recipient:ask:list_set_deny:version_current @t:permission:always:list_set_deny:version_current
  Scenario: A Deny set in the list takes the recipient and this agent's Always in one commit
    Given the recipient is "ask"
    And the agent's permission for the recipient is "always"
    And the owner's recipient act carries the current version
    And the owner's permission act carries the current version
    When the agent's permission takes the list's Deny
    Then the agent's permission for the recipient is "none"
    When the owner sets the recipient to Deny in the list
    Then the recipient is "deny"
    And a Deny holds for every agent of the wallet
    And a permission lives only under a known recipient that is not denied
