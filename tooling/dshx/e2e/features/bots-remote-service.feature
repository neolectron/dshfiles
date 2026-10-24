@bots
Feature: Remote Bots account service stays the sole data owner
  The real DSH GUI consumes Node-service metadata without inheriting its backend credentials.
  This synthetic journey proves an authorization refusal, not provider access or a successful Dot conversation.

  @scenario:bots.remote-service-account-denied
  Scenario: Show remote account metadata and refuse an unadmitted private authority before provider access
    Given the Bots workspace is backed by an isolated Node account service
    When the Bots workspace is opened
    And the bot connection dialog is opened
    Then the remote service supplies one nonsecret account field and requires risk acceptance
    When the remote account connection risks are accepted and submitted
    Then the remote authority refusal is sanitized without a bot or private browser bytes
    And only the standalone service owns the denied Bots connection state
