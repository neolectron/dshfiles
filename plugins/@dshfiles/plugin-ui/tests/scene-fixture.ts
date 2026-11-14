/**
 * Real pixels of every built-in scene's resting picture, rasterised by Chrome at the client's sample size
 * (`plugins/@dshfiles/ui-styles/scripts/sample-scenes.mjs` regenerates them). Tests that hold every theme to its
 * readability over its scene read them here.
 */
import type { Rgb } from '../src/theme/readability.ts'
import { columnOfSample, type SceneSource } from '../src/theme/theme-definition.ts'
import fixture from './fixtures/scene-samples.json' with { type: 'json' }

const pixelsOf = (base64: string): Rgb[] => {
  const bytes = Buffer.from(base64, 'base64')
  const pixels: Rgb[] = []
  for (let index = 0; index + 2 < bytes.length; index += 3) pixels.push([bytes[index] ?? 0, bytes[index + 1] ?? 0, bytes[index + 2] ?? 0])
  return pixels
}

/** Every built-in scene as the client has it once sampled (the SVG is a stand-in: the tests read only the pixels). */
export const SAMPLED_SCENES: ReadonlyMap<string, SceneSource> = new Map(
  Object.entries(fixture.samples).flatMap(([id, base64]) => {
    if (typeof base64 !== 'string') return []
    const surround = pixelsOf(base64)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"><title>${id}</title></svg>`
    return [[id, { svg, sample: columnOfSample(surround), surround }] as const]
  }),
)
