# Vendored: Claude Code `theme-examples` scenes

- Source: https://github.com/anthropics/claude-plugins-official/tree/893173fb82a7184fcf3f08ae55930016d84fd588/plugins/theme-examples/hooks/scenes
- Revision: `893173fb82a7184fcf3f08ae55930016d84fd588`
- License: Apache License 2.0 (`LICENSE` in this folder), Copyright Anthropic, PBC.
- Changes: relative imports end in `.js` for NodeNext resolution. The scene code is otherwise unchanged; each file builds
  one self-contained animated SVG (no script, no external reference) that `../../scenes.ts` serves to the client.
- Update policy: re-copy the `scenes/` folder from a newer revision, reapply the import change, update the revision
  here, and rerun `pnpm --dir plugins/@dshfiles/ui-styles test` (the scene safety test checks every SVG).
