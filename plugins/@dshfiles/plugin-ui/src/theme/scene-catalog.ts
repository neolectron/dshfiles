/**
 * The built-in backdrop scenes: the twenty animated SVG scenes of Claude Code's `theme-examples` plugin (Apache-2.0,
 * vendored in `@dshfiles/ui-styles/src/vendor/theme-examples`). Only their metadata lives here, so the browser bundle
 * stays small: the Host builds a scene's SVG and the client asks for it once it is shown.
 *
 * `glass` is the frosted layer Claude Code puts between a scene and the conversation: a blur, a tint and its opacity.
 */

export interface SceneGlass {
  /** Blur radius in px, 0–30. */
  readonly blur: number
  /** #rrggbb. */
  readonly tint: string
  /** 0–1. */
  readonly opacity: number
}

export interface SceneInfo {
  readonly id: string
  readonly title: string
  readonly blurb: string
  /** The window the scene is painted for: its text reads on it only in that scheme. */
  readonly window: 'light' | 'dark'
  readonly glass: SceneGlass
}

export const SCENES = [
  {
    id: 'honu-lagoon',
    title: 'Honu Lagoon',
    blurb: 'A live ASCII lagoon from above: a tile turtle swims by a sand island.',
    window: 'light',
    glass: { blur: 7, tint: '#e6fbff', opacity: 0.42 },
  },
  {
    id: 'koi-mosaic',
    title: 'Koi Mosaic',
    blurb: 'A tiled koi pond from above: two koi, lily pads, slow ripples.',
    window: 'light',
    glass: { blur: 12, tint: '#eef8f1', opacity: 0.36 },
  },
  {
    id: 'halftone-dawn',
    title: 'Halftone Dawn',
    blurb: 'A two-ink riso sunrise: halftone dots that breathe outward.',
    window: 'light',
    glass: { blur: 14, tint: '#f6ead9', opacity: 0.55 },
  },
  {
    id: 'halftone-dusk',
    title: 'Halftone Dusk',
    blurb: 'The riso sunrise on night-blue stock: an ember sun in breathing dots.',
    window: 'dark',
    glass: { blur: 14, tint: '#1f2336', opacity: 0.5 },
  },
  {
    id: 'plotter-tide',
    title: 'Plotter Tide',
    blurb: 'Pen-plotter tide lines drawing themselves on warm paper.',
    window: 'light',
    glass: { blur: 0, tint: '#f4efe4', opacity: 0.32 },
  },
  {
    id: 'plotter-tide-night',
    title: 'Plotter Tide, Night',
    blurb: "The plotter's tide chart in pale ink on blue-black night paper.",
    window: 'dark',
    glass: { blur: 0, tint: '#141a27', opacity: 0.32 },
  },
  {
    id: 'dither-dunes',
    title: 'Dither Dunes',
    blurb: 'One-bit dunes on sand paper, shaded in dots, under a terracotta sun.',
    window: 'light',
    glass: { blur: 18, tint: '#f1e8d6', opacity: 0.34 },
  },
  {
    id: 'dither-dunes-night',
    title: 'Dither Dunes Night',
    blurb: 'The same dunes after dark: pale dots on umber, an ember sun.',
    window: 'dark',
    glass: { blur: 18, tint: '#1c1712', opacity: 0.4 },
  },
  {
    id: 'paper-garden',
    title: 'Paper Garden',
    blurb: 'Cut-paper leaves at the edges of a warm white sheet, one coral bloom.',
    window: 'light',
    glass: { blur: 16, tint: '#fbf6ec', opacity: 0.5 },
  },
  {
    id: 'paper-garden-kraft',
    title: 'Paper Garden, Kraft',
    blurb: 'Cut-paper leaves at the edges of dark kraft paper, one coral bloom.',
    window: 'dark',
    glass: { blur: 16, tint: '#35312a', opacity: 0.5 },
  },
  {
    id: 'night-reef',
    title: 'Night Reef',
    blurb: 'The lagoon after dark: a turtle and a ray that glow as they swim.',
    window: 'dark',
    glass: { blur: 14, tint: '#0a1430', opacity: 0.4 },
  },
  {
    id: 'snow-pines',
    title: 'Snow Pines',
    blurb: 'An ASCII pine forest at dusk, snow drifting down through the trees.',
    window: 'dark',
    glass: { blur: 16, tint: '#14143a', opacity: 0.5 },
  },
  {
    id: 'braille-stars',
    title: 'Braille Stars',
    blurb: 'A slow night sky drawn dot by dot on a braille grid.',
    window: 'dark',
    glass: { blur: 20, tint: '#0a1430', opacity: 0.3 },
  },
  {
    id: 'teletext-clouds',
    title: 'Block Clouds',
    blurb: 'Night clouds built from blocks on a teletext grid, drifting in.',
    window: 'dark',
    glass: { blur: 12, tint: '#0d173f', opacity: 0.34 },
  },
  {
    id: 'vector-range',
    title: 'Vector Range',
    blurb: 'Phosphor mountains on black; an amber beam keeps retracing them.',
    window: 'dark',
    glass: { blur: 22, tint: '#0e2f27', opacity: 0.42 },
  },
  {
    id: 'departure-board',
    title: 'Departure Board',
    blurb: 'An amber LED board re-lettering itself, row by row.',
    window: 'dark',
    glass: { blur: 14, tint: '#1a120b', opacity: 0.34 },
  },
  {
    id: 'blueprint',
    title: 'Blueprint',
    blurb: 'A cyanotype sheet; a comet goes round its plotted orbit in the corner.',
    window: 'dark',
    glass: { blur: 14, tint: '#0c2444', opacity: 0.42 },
  },
  {
    id: 'deep-water',
    title: 'Deep Water',
    blurb: 'Light falling through deep water, and one quiet turtle.',
    window: 'dark',
    glass: { blur: 14, tint: '#062c3a', opacity: 0.34 },
  },
  { id: 'aurora', title: 'Aurora', blurb: 'Northern lights swaying over a dark ridge.', window: 'dark', glass: { blur: 18, tint: '#14123a', opacity: 0.3 } },
  {
    id: 'ember',
    title: 'Ember',
    blurb: 'A warm glow in the corners and a few embers rising.',
    window: 'dark',
    glass: { blur: 12, tint: '#2a0d12', opacity: 0.3 },
  },
] as const satisfies readonly SceneInfo[]

export type SceneId = (typeof SCENES)[number]['id']

export const SCENE_IDS: readonly string[] = SCENES.map(scene => scene.id)

/** The scene with this id, when it is one. */
function findScene(id: string): SceneInfo | undefined {
  return SCENES.find(scene => scene.id === id)
}

/**
 * A scene's resting picture: its own reduced-motion rules applied unconditionally. An SVG painted as an image does not
 * see the page's `prefers-reduced-motion`, so the page swaps this one in under that query instead.
 */
function restingScene(svg: string): string {
  return svg.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)/gu, '@media all')
}

/** A scene's SVG as a CSS image: a percent-encoded data URL, so the browser fetches nothing. */
function sceneImage(svg: string): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
}

/** The built-in scene catalog: lookup, resting picture and CSS image. */
export class SceneCatalog {
  static readonly find = findScene
  static readonly resting = restingScene
  static readonly image = sceneImage
}
