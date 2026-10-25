@bot-openai-dot
Feature: Human-only Dot enrollment in the real DSH page
  An isolated real Chromium visits only a synthetic loopback page.
  The same retained browser serves a synthetic Dot protocol; no account or provider is contacted.

  @scenario:bot-openai-dot.human-browser-session
  Scenario: Complete a human browser lease and connect a synthetic Dot through the sole Node owner
    Given the real Dot connection page has an isolated browser and Node service
    Then Dot enrollment requires human consent without opening any browser
    When the human starts Dot enrollment and types only synthetic text into its real browser
    And the human explicitly chooses Use this session on the real Dot page
    Then the human viewer is revoked while the same browser remains usable only by Node
    When the synthetic Dot account is connected and one message is sent through Bots
    Then only Node owns the synthetic Dot conversation and one outbox operation
