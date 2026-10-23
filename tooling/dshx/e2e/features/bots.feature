@bots
Feature: Existing durable bots in a global workspace
  Bots are remote durable identities, not native DSH Sessions or model presets.

  @scenario:bots.empty-workspace
  Scenario: Open an honest empty Bots workspace without adapters
    Given the isolated plugin profile "@dshfiles/bots" is booted
    When the Bots workspace is opened
    Then the Bots roster is empty without native Session controls
    When the bot connection dialog is opened
    Then bot adapters are unavailable rather than sample identities

  @scenario:bots.connect-metadata
  Scenario: Render adapter credential metadata and require risk acceptance
    Given the isolated plugin composition of "@dshfiles/bots, @dshfiles/bot-openai-dot" is booted
    When the Bots workspace is opened
    And the bot connection dialog is opened
    Then the bot adapter form uses two secret references and explicit risk acceptance

  @scenario:bots.fixture-conversation
  Scenario: Message an existing synthetic bot, preserve drafts and control local sync
    Given the Bots workspace with an isolated synthetic adapter is booted
    When the Bots workspace is opened
    And the synthetic existing bot is connected after accepting its risks
    Then the synthetic bot identity and local-cache scope are shown
    When bot drafts are written in two provider conversations
    Then each bot conversation keeps its own draft
    When "Hello from the Bots workspace" is sent to the synthetic bot
    Then the bot echo and unsolicited update arrive without a native Session
    When the Bots pane is 360 pixels wide
    Then narrow Bots navigation returns to the roster and conversation
    When the Bots pane is 480 pixels wide
    Then narrow Bots navigation returns to the roster and conversation
    When the synthetic bot is disconnected
    Then its conversation becomes read-only while its draft stays
    When the synthetic bot is reconnected
    Then reconnect does not resend the draft
    When local bot removal is cancelled
    Then the synthetic bot remains connected
    When local bot removal is confirmed
    Then the local roster is empty again
