@bots
Feature: Optional credential-management authority is explicit and revocable
  The fixture exercises the real Host API, durable permission and consent UI without a vault.

  @scenario:bots.credential-management
  Scenario: Grant and revoke permission without silently opting in during connect
    Given the Bots workspace with an isolated synthetic adapter is booted
    When the Bots workspace is opened
    And the synthetic existing bot is connected after accepting its risks
    Then synthetic credential management is not granted
    When the synthetic credential permission dialog is cancelled after consent
    And the synthetic credential permission dialog is reopened
    Then synthetic credential consent is unchecked and enabling is disabled
    When synthetic credential management is explicitly enabled
    Then synthetic credential management remains enabled after a reload
    When synthetic credential management is revoked
    Then synthetic credential management is not granted and the conversation remains connected
