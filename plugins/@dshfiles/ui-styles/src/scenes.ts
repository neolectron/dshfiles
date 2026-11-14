/**
 * The Host side of the built-in backdrop scenes: each id of `SCENES` (plugin-ui scene-catalog) to the vendored builder
 * that paints it. Built on first request and kept, so a Host pays only for the scenes someone shows. The browser bundle
 * never carries the builders; the client asks for a scene's SVG through the `scene` method of the theme API.
 */
import type { SceneId } from '@dshfiles/plugin-ui/theme/scenes'
import { blueprintSvg } from './vendor/theme-examples/blueprint.js'
import { brailleStarsSvg } from './vendor/theme-examples/braille-stars.js'
import { auroraSvg, deepWaterSvg, emberSvg } from './vendor/theme-examples/classic.js'
import { departureBoardSvg } from './vendor/theme-examples/departure-board.js'
import { ditherDunesNightSvg, ditherDunesSvg } from './vendor/theme-examples/dither-dunes.js'
import { halftoneDawnSvg, halftoneDuskSvg } from './vendor/theme-examples/halftone-dawn.js'
import { honuLagoonSvg } from './vendor/theme-examples/honu-lagoon.js'
import { koiMosaicSvg } from './vendor/theme-examples/koi-mosaic.js'
import { nightReefSvg } from './vendor/theme-examples/night-reef.js'
import { paperGardenKraftSvg, paperGardenSvg } from './vendor/theme-examples/paper-garden.js'
import { plotterTideNightSvg, plotterTideSvg } from './vendor/theme-examples/plotter-tide.js'
import { snowPinesSvg } from './vendor/theme-examples/snow-pines.js'
import { teletextCloudsSvg } from './vendor/theme-examples/teletext-clouds.js'
import { vectorRangeSvg } from './vendor/theme-examples/vector-range.js'

const BUILDERS = {
  'honu-lagoon': honuLagoonSvg,
  'koi-mosaic': koiMosaicSvg,
  'halftone-dawn': halftoneDawnSvg,
  'halftone-dusk': halftoneDuskSvg,
  'plotter-tide': plotterTideSvg,
  'plotter-tide-night': plotterTideNightSvg,
  'dither-dunes': ditherDunesSvg,
  'dither-dunes-night': ditherDunesNightSvg,
  'paper-garden': paperGardenSvg,
  'paper-garden-kraft': paperGardenKraftSvg,
  'night-reef': nightReefSvg,
  'snow-pines': snowPinesSvg,
  'braille-stars': brailleStarsSvg,
  'teletext-clouds': teletextCloudsSvg,
  'vector-range': vectorRangeSvg,
  'departure-board': departureBoardSvg,
  blueprint: blueprintSvg,
  'deep-water': deepWaterSvg,
  aurora: auroraSvg,
  ember: emberSvg,
} as const satisfies Record<SceneId, () => string>

const built = new Map<string, string>()

const isSceneId = (id: string): id is SceneId => Object.hasOwn(BUILDERS, id)

/** The SVG of a built-in scene, or undefined for an unknown id. */
function sceneSvg(id: string): string | undefined {
  const ready = built.get(id)
  if (ready !== undefined) return ready
  if (!isSceneId(id)) return undefined
  const svg = BUILDERS[id]()
  built.set(id, svg)
  return svg
}

/** Built-in scene SVGs, built once per Host. */
export class Scenes {
  static readonly svg = sceneSvg
}
