/**
 * Built-in gallery themes: one per Claude Code `theme-examples` scene, the four scenes painted for both kinds of window
 * paired into one theme (light and dark). Each scheme paints its scene behind the conversation under the scene's glass;
 * its colours are the generated palette retuned to the glass tint's hue and an accent picked for the scene, so text keeps
 * WCAG AA. A scene painted for one kind of window only shows in that scheme; the other keeps the generated palette.
 */
import { NEUTRAL_STEP_NAMES, PaletteMath, type Scheme } from './palette.ts'
import { SceneCatalog, type SceneInfo } from './scene-catalog.ts'
import type { SchemeTheme, ThemeDefinition } from './theme-definition.ts'

interface GalleryEntry {
  readonly id: string
  readonly label: string
  readonly light?: string
  readonly dark?: string
  /** Accent hue, picked from the scene's own colours. */
  readonly accentHue: number
}

const ENTRIES: readonly GalleryEntry[] = [
  { id: 'honu-lagoon', label: 'Honu Lagoon', light: 'honu-lagoon', accentHue: 215 },
  { id: 'koi-mosaic', label: 'Koi Mosaic', light: 'koi-mosaic', accentHue: 160 },
  { id: 'halftone', label: 'Halftone', light: 'halftone-dawn', dark: 'halftone-dusk', accentHue: 35 },
  { id: 'plotter-tide', label: 'Plotter Tide', light: 'plotter-tide', dark: 'plotter-tide-night', accentHue: 240 },
  { id: 'dither-dunes', label: 'Dither Dunes', light: 'dither-dunes', dark: 'dither-dunes-night', accentHue: 35 },
  { id: 'paper-garden', label: 'Paper Garden', light: 'paper-garden', dark: 'paper-garden-kraft', accentHue: 25 },
  { id: 'night-reef', label: 'Night Reef', dark: 'night-reef', accentHue: 190 },
  { id: 'snow-pines', label: 'Snow Pines', dark: 'snow-pines', accentHue: 165 },
  { id: 'braille-stars', label: 'Braille Stars', dark: 'braille-stars', accentHue: 255 },
  { id: 'teletext-clouds', label: 'Block Clouds', dark: 'teletext-clouds', accentHue: 250 },
  { id: 'vector-range', label: 'Vector Range', dark: 'vector-range', accentHue: 75 },
  { id: 'departure-board', label: 'Departure Board', dark: 'departure-board', accentHue: 70 },
  { id: 'blueprint', label: 'Blueprint', dark: 'blueprint', accentHue: 230 },
  { id: 'deep-water', label: 'Deep Water', dark: 'deep-water', accentHue: 200 },
  { id: 'aurora', label: 'Aurora', dark: 'aurora', accentHue: 160 },
  { id: 'ember', label: 'Ember', dark: 'ember', accentHue: 35 },
]

const ROLE_OF_STEP = {
  bg: 'bg',
  panel: 'panel',
  raised: 'raised',
  selected: 'selected',
  line: 'line',
  border: 'border',
  'border-strong': 'borderStrong',
  strong: 'strong',
  faint: 'faint',
  muted: 'muted',
  text: 'text',
} as const satisfies Record<(typeof NEUTRAL_STEP_NAMES)[number], string>

/** One scheme of a gallery theme: the scene, its glass, and the palette generated from the glass tint and the accent. */
function schemeOf(scene: SceneInfo, accentHue: number, scheme: Scheme): SchemeTheme {
  const tint = PaletteMath.hexToOklch(scene.glass.tint)
  const p = PaletteMath.palette({ hue: Number(tint.h.toFixed(1)), chroma: Math.min(0.03, Number(tint.c.toFixed(4))), accentHue, contrast: 1, scheme })
  const hex = PaletteMath.toHex
  const neutral = Object.fromEntries(NEUTRAL_STEP_NAMES.map((name, step) => [ROLE_OF_STEP[name], hex(p.neutral[step] ?? p.neutral[0] ?? tint)]))
  return {
    colours: {
      bg: neutral.bg ?? '',
      panel: neutral.panel ?? '',
      raised: neutral.raised ?? '',
      selected: neutral.selected ?? '',
      line: neutral.line ?? '',
      border: neutral.border ?? '',
      borderStrong: neutral.borderStrong ?? '',
      strong: neutral.strong ?? '',
      faint: neutral.faint ?? '',
      muted: neutral.muted ?? '',
      text: neutral.text ?? '',
      accent: hex(p.accent.fg),
      onAccent: hex(p.accent.onSolid),
      success: hex(p.success.fg),
      warning: hex(p.warning.fg),
      danger: hex(p.danger.fg),
      info: hex(p.info.fg),
    },
    backdrop: { scene: scene.id, glass: scene.glass },
  }
}

function build(entry: GalleryEntry): ThemeDefinition {
  const light = entry.light === undefined ? undefined : SceneCatalog.find(entry.light)
  const dark = entry.dark === undefined ? undefined : SceneCatalog.find(entry.dark)
  const blurbs = [light, dark].filter(scene => scene !== undefined).map(scene => scene.blurb)
  const kinds = light !== undefined && dark !== undefined ? 'light and dark' : light !== undefined ? 'light windows' : 'dark windows'
  let definition: ThemeDefinition = { id: entry.id, label: entry.label, description: `${blurbs.join(' ')} Made for ${kinds}.`.slice(0, 200) }
  if (light !== undefined) definition = { ...definition, light: schemeOf(light, entry.accentHue, 'light') }
  if (dark !== undefined) definition = { ...definition, dark: schemeOf(dark, entry.accentHue, 'dark') }
  return definition
}

export const GALLERY_THEMES: readonly ThemeDefinition[] = ENTRIES.map(build)

export const GALLERY_IDS: readonly string[] = GALLERY_THEMES.map(theme => theme.id)
