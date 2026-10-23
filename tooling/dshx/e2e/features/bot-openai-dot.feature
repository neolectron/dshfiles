@bot-openai-dot @fake-secret-cli
Feature: Existing OpenAI Dot adapter integration
  The real Host-only adapter registers with Bots without creating a Dot or authenticating an account.

  @scenario:bot-openai-dot.reference-linking
  Scenario: Present the registered Dot adapter with reference-only credentials and broad-account consent
    Given the isolated plugin composition of "@dshfiles/bots, @dshfiles/bot-openai-dot" is booted
    When the Bots workspace is opened
    And the bot connection dialog is opened
    Then the bot adapter form uses two secret references and explicit risk acceptance
