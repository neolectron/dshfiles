import { describe, expect, it } from 'vitest'
import { AppearanceModel, DEFAULT_APPEARANCE, RESERVED_THEME_IDS } from '../src/theme/appearance.ts'
import { GALLERY_THEMES } from '../src/theme/gallery.ts'
import type { Rgb } from '../src/theme/readability.ts'
import { SCENES } from '../src/theme/scene-catalog.ts'
import { BACKDROP_HOST, ThemeDefinitionModel } from '../src/theme/theme-definition.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"><rect width="1600" height="1000"/></svg>'
const DARK_PIXELS: Rgb[] = Array.from({ length: 40 }, () => [12, 14, 40])
const LIGHT_PIXELS: Rgb[] = Array.from({ length: 40 }, () => [230, 245, 250])
const WHITE_PIXELS: Rgb[] = Array.from({ length: 10 }, () => [250, 250, 255])
/** The same source for every built-in scene id. */
const scene = (svg: string, sample?: Rgb[]) => new Map(SCENES.map(({ id }) => [id, sample === undefined ? { svg } : { svg, sample }]))

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
    const css = AppearanceModel.runtimeThemeCss(settings, scene('<svg xmlns="http://www.w3.org/2000/svg"/>', LIGHT_PIXELS))
    const host = `html:root body:not([data-ds-dark-theme]) ${BACKDROP_HOST}`
    expect(css).toContain(`${host}::before {`)
    expect(css).toContain('background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg')
    expect(css).toContain('background-attachment: fixed;')
    // The glass is a gradient tint: nothing in the backdrop filters or masks the moving scene per frame.
    expect(css).toContain(`${host} .dv-dockview::before {\n  content: '';`)
    expect(css).not.toContain('backdrop-filter')
    // A light scene never shows in dark.
    expect(css).not.toContain(`body[data-ds-dark-theme][data-ds-dark-theme][data-ds-dark-theme] ${BACKDROP_HOST}`)
    // Under reduced motion the page swaps in the scene's resting picture: the image itself cannot see the query.
    const still = AppearanceModel.runtimeThemeCss(
      settings,
      scene('<svg><style>@media (prefers-reduced-motion: reduce){*{animation:none}}</style></svg>', LIGHT_PIXELS),
    )
    expect(still).toContain(encodeURIComponent('@media all{*{animation:none}}'))
    expect(AppearanceModel.scenesNeeded({ ...settings, accentHue: 10 })).toEqual([])
  })

  it('keeps its text readable over its scene with a veil, whatever the user asks', () => {
    const settings = { ...DEFAULT_APPEARANCE, customTheme: 'snow-pines' }
    const veil = '[data-conversation-content]::before {'
    // A calm, dark sky needs no veil; white snow under white text does (the glass already darkens it by half).
    expect(AppearanceModel.runtimeThemeCss(settings, scene(SVG, DARK_PIXELS))).not.toContain(veil)
    const snow = AppearanceModel.runtimeThemeCss(settings, scene(SVG, [...DARK_PIXELS, ...WHITE_PIXELS]))
    expect(snow).toContain(`${BACKDROP_HOST} ${veil}`)
    expect(snow).toContain('width: min(100%, calc(var(--dsh-chat-content-width, 760px) + 96px));')
    expect(snow).toMatch(/background-color: rgb\(\d+ \d+ \d+ \/ 0\.[3-9]\d*\);/u)
    // Before the client sampled the scene, a safe veil applies.
    expect(AppearanceModel.runtimeThemeCss(settings, scene(SVG))).toMatch(/background-color: rgb\(\d+ \d+ \d+ \/ 0\.7\);/u)
  })

  it('blurs a still of the scene under the column and tints it as far as asked, with no filter per frame', () => {
    const settings = { ...DEFAULT_APPEARANCE, customTheme: 'night-reef', readingBlur: 6, readingTint: 20 }
    const css = AppearanceModel.runtimeThemeCss(settings, scene(SVG, DARK_PIXELS))
    expect(css).toContain(encodeURIComponent('<feGaussianBlur stdDeviation="6.00"/>'))
    expect(css).toContain('background-attachment: scroll, fixed;')
    expect(css).toMatch(/linear-gradient\(rgb\(\d+ \d+ \d+ \/ 0\.2\)/u)
    expect(css).not.toContain('backdrop-filter')
    // Out-of-bounds values are clamped; a theme without a backdrop has nothing to veil.
    expect(AppearanceModel.runtimeThemeCss({ ...settings, readingBlur: 99 }, scene(SVG, DARK_PIXELS))).toContain(encodeURIComponent('stdDeviation="24.00"'))
    expect(AppearanceModel.runtimeThemeCss({ ...DEFAULT_APPEARANCE, preset: 'moss', readingTint: 80 })).not.toContain('[data-conversation-content]::before')
  })

  it('lets a saved theme paint a scene, and refuses an unknown one', () => {
    const colours = GALLERY_THEMES[0]?.light?.colours
    const theme = { id: 'lagoon-mine', label: 'Mine', light: { colours, backdrop: { scene: 'honu-lagoon', layers: ['opacity: 0.5'] } } }
    expect(ThemeDefinitionModel.parse(theme).errors).toEqual([])
    const unknown = ThemeDefinitionModel.parse({ ...theme, light: { colours, backdrop: { scene: 'nope' } } }).errors
    expect(unknown[0]).toMatch(/^light\.backdrop\.scene: one of honu-lagoon/u)
  })
})
