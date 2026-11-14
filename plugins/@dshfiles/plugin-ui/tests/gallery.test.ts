import { describe, expect, it } from 'vitest'
import { AppearanceModel, DEFAULT_APPEARANCE, RESERVED_THEME_IDS } from '../src/theme/appearance.ts'
import { GALLERY_THEMES } from '../src/theme/gallery.ts'
import { SCENES } from '../src/theme/scene-catalog.ts'
import { BACKDROP_HOST, ThemeDefinitionModel } from '../src/theme/theme-definition.ts'

describe('gallery themes', () => {
  it('paints every built-in scene once, each in the scheme it is drawn for', () => {
    const painted = GALLERY_THEMES.flatMap(theme =>
      (['light', 'dark'] as const).flatMap(scheme => {
        const scene = theme[scheme]?.backdrop?.scene
        return scene === undefined ? [] : [`${scene}:${scheme}`]
      }),
    )
    expect(painted.sort()).toEqual(SCENES.map(scene => `${scene.id}:${scene.window}`).sort())
  })

  it('are valid definitions whose text keeps WCAG AA', () => {
    for (const theme of GALLERY_THEMES) {
      expect(ThemeDefinitionModel.parse(theme).errors, theme.id).toEqual([])
      expect(ThemeDefinitionModel.contrastWarnings(theme), theme.id).toEqual([])
      expect(RESERVED_THEME_IDS).toContain(theme.id)
    }
  })

  it('paints the scene under its glass once the client has its SVG, and asks for it until then', () => {
    const settings = { ...DEFAULT_APPEARANCE, customTheme: 'honu-lagoon' }
    expect(AppearanceModel.scenesNeeded(settings)).toEqual(['honu-lagoon'])
    const bare = AppearanceModel.runtimeThemeCss(settings)
    expect(bare).not.toContain('data:image/svg+xml')
    const css = AppearanceModel.runtimeThemeCss(settings, new Map([['honu-lagoon', '<svg xmlns="http://www.w3.org/2000/svg"/>']]))
    const host = `html:root body:not([data-ds-dark-theme]) ${BACKDROP_HOST}`
    expect(css).toContain(`${host}::before {`)
    expect(css).toContain('background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg')
    expect(css).toContain(`${host} .dv-dockview::before {`)
    expect(css).toContain('backdrop-filter: blur(7px);')
    // A light scene never shows in dark.
    expect(css).not.toContain(`body[data-ds-dark-theme][data-ds-dark-theme][data-ds-dark-theme] ${BACKDROP_HOST}`)
    // Under reduced motion the page swaps in the scene's resting picture: the image itself cannot see the query.
    const still = AppearanceModel.runtimeThemeCss(
      settings,
      new Map([['honu-lagoon', '<svg><style>@media (prefers-reduced-motion: reduce){*{animation:none}}</style></svg>']]),
    )
    expect(still).toContain(encodeURIComponent('@media all{*{animation:none}}'))
    expect(AppearanceModel.scenesNeeded({ ...settings, accentHue: 10 })).toEqual([])
  })

  it('lets a saved theme paint a scene, and refuses an unknown one', () => {
    const colours = GALLERY_THEMES[0]?.light?.colours
    const theme = { id: 'lagoon-mine', label: 'Mine', light: { colours, backdrop: { scene: 'honu-lagoon', layers: ['opacity: 0.5'] } } }
    expect(ThemeDefinitionModel.parse(theme).errors).toEqual([])
    const unknown = ThemeDefinitionModel.parse({ ...theme, light: { colours, backdrop: { scene: 'nope' } } }).errors
    expect(unknown[0]).toMatch(/^light\.backdrop\.scene: one of honu-lagoon/u)
  })
})
