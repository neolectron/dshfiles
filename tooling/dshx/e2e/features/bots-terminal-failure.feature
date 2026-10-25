@bots
Feature: Terminal provider failures stop a durable Bots connection
  A synthetic adapter refusal must fence provider work without losing the failed message.
  Reconnect is explicit and never resends the original message automatically.

  @scenario:bots.terminal-send-failure
  Scenario: Stop sending and polling after access denial until explicit reconnect
    Given the Bots workspace with an isolated terminal-failure adapter is booted
    When the Bots workspace is opened
    And the synthetic terminal bot is connected and selected
    And one synthetic message is sent to the terminal bot
    Then the terminal refusal immediately makes the conversation read-only and retains the failed message
    When another synthetic send is attempted while disconnected
    Then one native owner retains one failed send and no provider work resumes
    When the terminal bot is explicitly reconnected
    Then connection is restored without automatically resending the failed message
    And the Web UI is torn down cleanly
    And all terminal fixture resources are gone
