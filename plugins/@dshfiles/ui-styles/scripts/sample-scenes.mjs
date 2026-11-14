#!/usr/bin/env node
/**
 * Regenerates `plugin-ui/tests/fixtures/scene-samples.json`: every built-in scene's resting picture rasterised by
 * Chrome at 64×40, exactly as the ui-styles client samples it for the reading veil (client.ts `sampleScene`). The
 * all-theme readability tests run on these real pixels, so a new or changed scene needs a fresh run:
 *
 *   node plugins/@dshfiles/ui-styles/scripts/sample-scenes.mjs
 *
 * Chromium comes from tooling/dshx's Playwright; set DSHX_CHROMIUM_EXECUTABLE to use an installed Chrome instead.
 */
import { createRequire } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../../..')
const vendor = join(here, '../src/vendor/theme-examples')
const out = join(repo, 'plugins/@dshfiles/plugin-ui/tests/fixtures/scene-samples.json')

/** The vendored builders are plain TypeScript without imports: Node strips their types. */
const builders = {}
for (const file of readdirSync(vendor).filter(name => name.endsWith('.ts'))) Object.assign(builders, await import(pathToFileURL(join(vendor, file)).href))

/** Scene id → builder export, mirrored from ui-styles/src/scenes.ts. */
const BUILDERS = {
  'honu-lagoon': 'honuLagoonSvg',
  'koi-mosaic': 'koiMosaicSvg',
  'halftone-dawn': 'halftoneDawnSvg',
  'halftone-dusk': 'halftoneDuskSvg',
  'plotter-tide': 'plotterTideSvg',
  'plotter-tide-night': 'plotterTideNightSvg',
  'dither-dunes': 'ditherDunesSvg',
  'dither-dunes-night': 'ditherDunesNightSvg',
  'paper-garden': 'paperGardenSvg',
  'paper-garden-kraft': 'paperGardenKraftSvg',
  'night-reef': 'nightReefSvg',
  'snow-pines': 'snowPinesSvg',
  'braille-stars': 'brailleStarsSvg',
  'teletext-clouds': 'teletextCloudsSvg',
  'vector-range': 'vectorRangeSvg',
  'departure-board': 'departureBoardSvg',
  blueprint: 'blueprintSvg',
  'deep-water': 'deepWaterSvg',
  aurora: 'auroraSvg',
  ember: 'emberSvg',
}

/** SceneCatalog.resting: the scene's reduced-motion rules applied unconditionally. */
const resting = svg => svg.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)/gu, '@media all')

const require = createRequire(join(repo, 'tooling/dshx/package.json'))
const { chromium } = require('playwright')
const executablePath = process.env.DSHX_CHROMIUM_EXECUTABLE
const browser = await chromium.launch(executablePath === undefined || executablePath === '' ? {} : { executablePath })
const page = await browser.newPage()
const samples = {}
for (const [id, name] of Object.entries(BUILDERS)) {
  const build = builders[name]
  if (typeof build !== 'function') throw new Error(`no builder ${name} for ${id}`)
  const svg = resting(build())
  // Same drawing as the client: decode the data URL, draw into 64×40, read every pixel.
  const bytes = await page.evaluate(async source => {
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 40
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0, 64, 40)
    const { data } = context.getImageData(0, 0, 64, 40)
    const rgb = []
    for (let index = 0; index < data.length; index += 4) rgb.push(data[index], data[index + 1], data[index + 2])
    return rgb
  }, svg)
  samples[id] = Buffer.from(bytes).toString('base64')
}
await browser.close()
writeFileSync(out, `${JSON.stringify({ width: 64, height: 40, encoding: 'base64 rgb rows', samples }, null, 1)}\n`)
console.log(`wrote ${Object.keys(samples).length} scenes to ${out}`)
