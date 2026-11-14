import { createApiClient, defineClient } from '@dshfiles/dshx/client'
import { AppearanceModel, type AppearanceSettings } from '@dshfiles/plugin-ui/theme/appearance'
import { themeApi } from './api.js'
import './client.css'
import { RuntimeTheme, RUNTIME_STYLE_ID } from './runtime-theme.js'
import { UI_STYLES_SETTINGS_NAMESPACE } from './settings-namespace.js'

export default defineClient({
  name: '@dshfiles/ui-styles',
  inject: ['configForms'],
  setup(ctx) {
    // Before the settings mirror answers: the last custom theme, so a reload does not flash the default.
    const cached = RuntimeTheme.readCachedThemeCss()
    RuntimeTheme.applyThemeCss<HTMLElement>(document, cached)
    const form = ctx.configForms.get<Partial<AppearanceSettings>>(UI_STYLES_SETTINGS_NAMESPACE)
    const theme = createApiClient(ctx, themeApi)
    // Built-in scene SVGs come from the Host on first use, so the browser bundle never carries their builders.
    const scenes = new Map<string, string>()
    const loading = new Set<string>()
    const failed = new Set<string>()
    let applied = cached
    let disposed = false
    const sync = (): void => {
      const snapshot = form.getSnapshot()
      if (snapshot.status === 'loading') return
      const value = snapshot.status === 'ready' ? snapshot.value : undefined
      const missing = AppearanceModel.scenesNeeded(value).filter(id => !scenes.has(id) && !failed.has(id))
      for (const id of missing) {
        if (loading.has(id)) continue
        loading.add(id)
        theme.scene({ id }).then(
          ({ svg }) => {
            scenes.set(id, svg)
            loading.delete(id)
            if (!disposed) sync()
          },
          (error: unknown) => {
            // The theme still applies without its scene; the colours and any layers stay.
            console.warn(`dshfiles-ui-styles: the backdrop scene "${id}" could not be loaded`, error)
            failed.add(id)
            loading.delete(id)
            if (!disposed) sync()
          },
        )
      }
      // Keep the cached sheet (which holds the scene) until the scene arrives, instead of flashing a bare theme.
      if (missing.length > 0 && applied !== '') return
      // `unavailable` is a Host that predates the Appearance settings (or has none): the static default applies.
      const css = value === undefined ? '' : AppearanceModel.runtimeThemeCss(value, scenes)
      RuntimeTheme.applyThemeCss<HTMLElement>(document, css)
      RuntimeTheme.writeCachedThemeCss(css)
      applied = css
    }
    ctx.effect(() => {
      sync()
      void ctx.configForms.describe().ensure()
      const unsubscribe = form.subscribe(sync)
      return () => {
        disposed = true
        unsubscribe()
        document.getElementById(RUNTIME_STYLE_ID)?.remove()
      }
    }, 'dshfiles-ui-styles: apply the Appearance theme')
  },
})
