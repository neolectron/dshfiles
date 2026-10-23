@dot-auth-viewer
Feature: Human-only Dot auth viewer on native isolated DSH
  This fixture compiles the existing source-only viewer and HTTP routes, not a production integration.
  Every pixel and input belongs to a synthetic local fixture; no provider, account or vault is used.

  Scenario: Native consent raster trusted input and acknowledged cancellation
    Given the native synthetic Dot auth viewer profile is booted
    Then the Web UI mounts without a plugin failure card
    And synthetic Dot consent is unchecked and no browser has opened
    When synthetic Dot consent is accepted and the raster is started
    Then the known synthetic JPEG is decoded in the real viewer canvas
    When trusted pointer keyboard and browser text input reach the synthetic port
    Then mapped coordinates and text change only the synthetic pixels
    When the synthetic browser is cancelled
    Then native cancellation is acknowledged and private raster input is cleared

  Scenario: Native status failure stops viewing without an automatic retry
    Given the native synthetic Dot auth viewer profile is booted
    Then the Web UI mounts without a plugin failure card
    When synthetic Dot consent is accepted and the raster is started
    And the native synthetic status route refuses once
    Then the viewer clears private pixels and does not retry status
