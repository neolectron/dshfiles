import { SCENES } from '@dshfiles/plugin-ui/theme/scenes'
import { describe, expect, it } from 'vitest'
import { Scenes } from '../src/scenes.ts'

describe('built-in scenes', () => {
  it('builds every catalog scene as a self-contained SVG that loads nothing', () => {
    for (const { id } of SCENES) {
      const svg = Scenes.svg(id)
      expect(svg, id).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
      expect(svg, id).not.toMatch(/<script|<image|<foreignObject|href="(?!#)|url\((?!#)|@import/iu)
      // Each scene rests in a composed picture under reduced motion.
      expect(svg, id).toContain('prefers-reduced-motion')
      expect(svg!.length, id).toBeLessThan(120_000)
    }
  })

  it('builds a scene once and refuses an unknown id', () => {
    expect(Scenes.svg('aurora')).toBe(Scenes.svg('aurora'))
    expect(Scenes.svg('nope')).toBeUndefined()
  })
})
