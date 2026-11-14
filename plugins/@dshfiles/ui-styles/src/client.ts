import { createApiClient, defineClient } from '@dshfiles/dshx/client'
import { AppearanceModel, type AppearanceSettings } from '@dshfiles/plugin-ui/theme/appearance'
import type { Rgb } from '@dshfiles/plugin-ui/theme/readability'
import { SceneCatalog } from '@dshfiles/plugin-ui/theme/scenes'
import type { SceneSource } from '@dshfiles/plugin-ui/theme/definition'
import { themeApi } from './api.js'
import './client.css'
import { RuntimeTheme, RUNTIME_STYLE_ID } from './runtime-theme.js'
import { UI_STYLES_SETTINGS_NAMESPACE } from './settings-namespace.js'

/**
 * A coarse sample of a scene's resting picture under the conversation column: the middle 60% of its width, drawn once
 * at 64×40. The theme turns it into the veil its text needs (ReadabilityModel). Undefined when the browser cannot decode
 * the SVG; the theme then uses a safe veil.
 */
async function sampleScene(svg: string): Promise<readonly Rgb[] | undefined> {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SceneCatalog.resting(svg))}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 40
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return undefined
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const { data } = context.getImageData(13, 0, 38, 40)
  const pixels: Rgb[] = []
  for (let index = 0; index + 2 < data.length; index += 4) pixels.push([data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0])
  return pixels
}

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
    const scenes = new Map<string, SceneSource>()
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
          async ({ svg }) => {
            // The sample decides the readability veil; without it the theme falls back to a safe one.
            const sample = await sampleScene(svg).catch(() => undefined)
            scenes.set(id, sample === undefined ? { svg } : { svg, sample })
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
