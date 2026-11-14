/**
 * Readability of text drawn straight over a backdrop scene. A theme owns it: from a coarse sample of the scene's resting
 * picture it works out the smallest veil (its own background colour at some opacity, laid under the conversation column)
 * that keeps its text readable over that scene, whatever the user's own blur and tint choices. Pure sRGB math, so the
 * client samples pixels once and the CSS stays a deterministic function of the sample.
 */

/** One sampled pixel, 0–255 per channel. */
export type Rgb = readonly [r: number, g: number, b: number]

export interface TextTarget {
  readonly colour: Rgb
  /** Minimum contrast ratio over the composited background. */
  readonly min: number
}

export interface VeilInput {
  /** Scene pixels under the conversation column. */
  readonly sample: readonly Rgb[]
  /** The veil colour: the theme's background. */
  readonly veil: Rgb
  /** A tint already laid over the scene there (the scene's glass), with its opacity. */
  readonly glass?: { readonly colour: Rgb; readonly opacity: number }
  readonly texts: readonly TextTarget[]
  /** Share of pixels that must read; stray stars and sparks above it are ignored. Default 0.95. */
  readonly coverage?: number
}

const channel = (value: number): number => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
// Browsers composite in sRGB: mixing the encoded channels is what the user sees.
const mix = (under: Rgb, over: Rgb, opacity: number): Rgb => [
  under[0] + (over[0] - under[0]) * opacity,
  under[1] + (over[1] - under[1]) * opacity,
  under[2] + (over[2] - under[2]) * opacity,
]

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

const reads = (under: Rgb, texts: readonly TextTarget[]): boolean => texts.every(text => contrast(text.colour, under) >= text.min)

/**
 * Each target as strict as it can be over a full veil: a colour that sits under its minimum on the theme's own
 * background (an official palette's faint step, say) asks only for what that background gives it. A veil never has to
 * read better than the plain theme, and the bisection always has a reachable target.
 */
const reachable = (veil: Rgb, texts: readonly TextTarget[]): TextTarget[] =>
  texts.map(text => ({ colour: text.colour, min: Math.min(text.min, contrast(text.colour, veil) - 0.05) }))

/** The smallest veil opacity for one pixel, found by bisection; 1 when even a full veil does not read. */
function veilFor(pixel: Rgb, veil: Rgb, texts: readonly TextTarget[]): number {
  if (reads(pixel, texts)) return 0
  if (!reads(veil, texts)) return 1
  let low = 0
  let high = 1
  for (let step = 0; step < 14; step += 1) {
    const middle = (low + high) / 2
    if (reads(mix(pixel, veil, middle), texts)) high = middle
    else low = middle
  }
  return high
}

/** The veil opacity (0–1, rounded up to 0.05) that keeps the targets readable over `coverage` of the sample. */
function minimumVeil(input: VeilInput): number {
  if (input.sample.length === 0) return 0
  const texts = reachable(input.veil, input.texts)
  const needs = input.sample
    .map(pixel => (input.glass === undefined ? pixel : mix(pixel, input.glass.colour, input.glass.opacity)))
    .map(pixel => veilFor(pixel, input.veil, texts))
    .sort((a, b) => a - b)
  const index = Math.min(needs.length - 1, Math.ceil((input.coverage ?? 0.95) * needs.length) - 1)
  const need = needs[Math.max(0, index)] ?? 0
  return Math.min(1, Math.max(0, Math.ceil(need * 20 - 1e-9) / 20))
}

/**
 * What a reader sees at one scene pixel: the scene, under the glass when there is one, under the veil at its opacity.
 * Browsers composite in sRGB, so this is the encoded-channel mix they draw.
 */
function composite(pixel: Rgb, veil: Rgb, opacity: number, glass?: VeilInput['glass']): Rgb {
  const glassed = glass === undefined ? pixel : mix(pixel, glass.colour, glass.opacity)
  return mix(glassed, veil, opacity)
}

/** Text readability over a backdrop: the veil a theme needs, and the colour helpers it uses. */
export class ReadabilityModel {
  static readonly minimumVeil = minimumVeil
  static readonly composite = composite
  static readonly contrast = contrast
  static readonly hexToRgb = hexToRgb
}
