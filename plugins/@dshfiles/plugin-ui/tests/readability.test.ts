import { describe, expect, it } from 'vitest'
import { ReadabilityModel, type Rgb } from '../src/theme/readability.ts'

const white: Rgb = [255, 255, 255]
const night: Rgb = [20, 22, 40]

describe('readability veil', () => {
  it('needs no veil where the text already reads, and a veil where it does not', () => {
    const texts = [{ colour: white, min: 4.5 }]
    expect(ReadabilityModel.minimumVeil({ sample: [night, night], veil: night, texts })).toBe(0)
    const need = ReadabilityModel.minimumVeil({ sample: [[240, 240, 240]], veil: night, texts })
    expect(need).toBeGreaterThan(0.5)
    expect(need).toBeLessThan(1)
    // The veil it returns does make the text read.
    const mixed: Rgb = [240 + (20 - 240) * need, 240 + (22 - 240) * need, 240 + (40 - 240) * need]
    expect(ReadabilityModel.contrast(white, mixed)).toBeGreaterThanOrEqual(4.5)
  })

  it('ignores stray bright pixels beyond its coverage, and counts the glass already over the scene', () => {
    const texts = [{ colour: white, min: 4.5 }]
    const sample: Rgb[] = [...Array.from({ length: 99 }, () => night), white]
    expect(ReadabilityModel.minimumVeil({ sample, veil: night, texts })).toBe(0)
    expect(ReadabilityModel.minimumVeil({ sample, veil: night, texts, coverage: 1 })).toBeGreaterThan(0)
    const glassed = ReadabilityModel.minimumVeil({ sample: [white], veil: night, texts, glass: { colour: night, opacity: 0.8 } })
    expect(glassed).toBeLessThan(ReadabilityModel.minimumVeil({ sample: [white], veil: night, texts }))
  })
})
