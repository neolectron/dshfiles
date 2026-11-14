import { PluginApiError } from '@dshfiles/dshx/api'
import { Api, DshxPlugin, hostService } from '@dshfiles/dshx/effect'
import { Settings } from '@dshfiles/dshx/effect/settings'
import type { SettingsValue } from '@dshfiles/dshx/settings'
import { Effect, Option, Schema } from 'effect'
import { themeApi } from './api.js'
import { appearanceSettings, UI_STYLES_SETTINGS_NAMESPACE } from './settings.js'
import { Scenes } from './scenes.js'
import { InvalidThemeDefinition, ThemeStateModel } from './theme-state.js'
import type { AppearanceSettings as Appearance } from '@dshfiles/plugin-ui/theme/appearance'

type AppearanceValue = SettingsValue<typeof appearanceSettings.schema>
const AppearanceSettings = Settings.Tag<AppearanceValue>(UI_STYLES_SETTINGS_NAMESPACE)

const decodeThemePreference = Schema.decodeUnknownOption(Schema.Struct({ preference: Schema.String }))

/** The Host's light/dark preference (`ui-theme.preference`), reported by `theme_get`; never written here. */
const readScheme = Effect.gen(function* () {
  const forms = yield* Effect.option(hostService('settings'))
  if (Option.isNone(forms)) return 'unknown'
  const row = forms.value.describe().find(item => item.ns === 'ui-theme')
  return Option.match(decodeThemePreference(row?.value), { onNone: () => 'unknown', onSome: ({ preference }) => preference })
}).pipe(Effect.catchCause(() => Effect.succeed('unknown')))

/**
 * One read-modify-write of the Appearance settings at the revision it read. A refused theme (invalid definition,
 * unknown saved theme) fails the call with its problems, so the agent can correct it and retry.
 */
const update = (change: (current: Appearance) => Appearance) =>
  Effect.gen(function* () {
    const settings = yield* AppearanceSettings
    const snapshot = yield* settings.snapshot
    const next = yield* Effect.try({
      try: () => change(ThemeStateModel.normaliseAppearance(snapshot.value)),
      catch: error =>
        error instanceof InvalidThemeDefinition
          ? new PluginApiError(error.message, { code: 'invalid-theme' })
          : new PluginApiError(`The theme could not be changed: ${String(error)}`, { code: 'theme-update-failed' }),
    })
    // Decoding through the contract validates the value and gives it the stored type; unset overrides stay absent.
    yield* settings.replace(appearanceSettings.schema({ ...next, customThemes: [...(next.customThemes ?? [])] }), snapshot.revision)
    return ThemeStateModel.themeState(next, yield* readScheme)
  })

/**
 * Host half of the theme owner (visual refresh T6.1–T6.3): the Appearance settings namespace and the
 * `theme_get` / `theme_set` agent tools. The Client half (`client.ts`) applies the same settings to the page.
 */
export default DshxPlugin.make({
  name: '@dshfiles/ui-styles',
  settings: [appearanceSettings],
  layer: Settings.layer(appearanceSettings),
  apis: [
    Api.bind(themeApi, {
      get: () =>
        Effect.gen(function* () {
          const settings = yield* AppearanceSettings
          const value = yield* settings.get
          return ThemeStateModel.themeState(ThemeStateModel.normaliseAppearance(value), yield* readScheme)
        }),
      set: input => update(current => ThemeStateModel.nextAppearance(current, input)),
      define: input => update(current => ThemeStateModel.defineTheme(current, input)),
      remove: input => update(current => ThemeStateModel.removeTheme(current, input.id)),
      scene: input =>
        Effect.gen(function* () {
          const svg = Scenes.svg(input.id)
          if (svg === undefined) return yield* Effect.fail(new PluginApiError(`No built-in scene "${input.id}".`, { code: 'unknown-scene' }))
          return { id: input.id, svg }
        }),
    }),
  ],
})
