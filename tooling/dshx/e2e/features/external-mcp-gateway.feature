@external-mcp-gateway
Feature: External MCP delegates to the actual native DSH Session runtime
  The external client has a scoped task API, not a second agent engine.
  Only the model provider is synthetic; the CLI, MCP wire, native Agent and logs are real.

  @native-session-lifecycle
  Scenario: Run, follow up, isolate and cancel one native task through the normal gateway CLI
    Given the external MCP gateway and synthetic provider use an isolated native DSH runtime
    When an external MCP client creates and repeats one task request
    Then the real DSH page shows the native task result
    When the external MCP client follows up and tests principal boundaries
    And the external MCP client cancels a blocked native turn
    Then the gateway and native Session evidence agree without exposing private bytes
    And the Web UI is torn down cleanly
    And all external MCP gateway fixture resources are gone
