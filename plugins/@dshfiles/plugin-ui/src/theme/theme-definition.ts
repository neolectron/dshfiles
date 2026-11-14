/**
 * Theme definitions: a theme as data (exact colours per scheme, optional syntax colours and an animated backdrop), so a
 * new theme is a settings value an agent can write, applied live, instead of code and a Host restart. Built-in themes
 * (Dracula) use the same format.
 *
 * A definition never replaces the generator: the generated blocks still retune every Host ramp from the theme's own hue
 * (read from its background and accent), then the definition pins the eleven steps, the accent and status colours and
 * the Shiki tokens it gives. A scheme the definition leaves out keeps the generated palette.
 */
import { PaletteMath, type PaletteInput, type Scheme } from './palette.ts'

/** The eleven neutral steps, in palette order (see `Palette.neutral`). */
export const NEUTRAL_ROLES = ['bg', 'panel', 'raised', 'selected', 'line', 'border', 'borderStrong', 'strong', 'faint', 'muted', 'text'] as const
export const ACCENT_ROLES = ['accent', 'onAccent', 'success', 'warning', 'danger', 'info'] as const
export const SYNTAX_ROLES = ['comment', 'punctuation', 'constant', 'keyword', 'parameter', 'function', 'string'] as const

export type NeutralRole = (typeof NEUTRAL_ROLES)[number]
export type AccentRole = (typeof ACCENT_ROLES)[number]
export type SyntaxRole = (typeof SYNTAX_ROLES)[number]
export type ColourRole = NeutralRole | AccentRole

/** What each role colours, for the agent tool description and the docs. */
export const ROLE_GUIDE = {
  bg: 'app and conversation background',
  panel: 'sidebar, cards and code blocks',
  raised: 'hover, bubbles and the composer',
  selected: 'selected rows and active items',
  line: 'hairline dividers',
  border: 'control borders',
  borderStrong: 'strong borders',
  strong: 'idle glyphs and scrollbars',
  faint: 'tertiary text and placeholders (3:1 on bg, panel and raised)',
  muted: 'secondary text (4.5:1)',
  text: 'primary text (4.5:1)',
  accent: 'links, focus, selection and the primary accent (4.5:1)',
  onAccent: 'text on a solid accent fill',
  success: 'success text and icons',
  warning: 'warning text and icons',
  danger: 'error and danger text',
  info: 'informational text',
  comment: 'code comments',
  punctuation: 'code punctuation and plain identifiers',
  constant: 'numbers and constants',
  keyword: 'keywords',
  parameter: 'parameters and variables',
  function: 'functions and methods',
  string: 'strings',
} as const satisfies Readonly<Record<ColourRole | SyntaxRole, string>>

const SYNTAX_ROLE_SET: ReadonlySet<string> = new Set(SYNTAX_ROLES)

/**
 * An animated backdrop painted behind the main workbench (the conversation and its tabs; sidebars, dialogs, bubbles and
 * the composer stay opaque). Each layer is a block of CSS declarations for one full-size layer (stacked in order, the
 * first at the back); DSH adds its position, size and stacking. Keyframes name the animations the layers use.
 * Self-contained: no `url()`, `@import` or braces in a layer, so a theme never loads anything from the network.
 */
export interface Backdrop {
  readonly layers: readonly string[]
  readonly keyframes?: string
}

export interface SchemeTheme {
  readonly colours: Readonly<Record<ColourRole, string>>
  readonly syntax?: Readonly<Partial<Record<SyntaxRole, string>>>
  readonly backdrop?: Backdrop
}

export interface ThemeDefinition {
  /** Lowercase letters, digits and hyphens; a built-in preset id is refused. */
  readonly id: string
  readonly label: string
  readonly description?: string
  /** At least one scheme. */
  readonly dark?: SchemeTheme
  readonly light?: SchemeTheme
}

export const MAX_BACKDROP_LAYERS = 3
const MAX_LAYER_LENGTH = 8_000
const MAX_KEYFRAMES_LENGTH = 4_000
const HEX = /^#[0-9a-f]{6}$/iu
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/u
const FORBIDDEN = /url\s*\(|@import|expression\s*\(|javascript:|<\/?style/iu

/** A JSON object from settings or a tool call, before its fields are checked. */
interface UntrustedObject {
  readonly [key: string]: unknown
}
const isRecord = (value: unknown): value is UntrustedObject => typeof value === 'object' && value !== null && !Array.isArray(value)

function checkKeyframes(text: string, errors: string[], where: string): void {
  if (text.length > MAX_KEYFRAMES_LENGTH) errors.push(`${where}: keyframes longer than ${MAX_KEYFRAMES_LENGTH} characters`)
  if (FORBIDDEN.test(text)) errors.push(`${where}: keyframes must not load anything (no url(), @import)`)
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (depth === 0 && char !== undefined && !/\s/u.test(char)) {
      const head = /^@keyframes\s+[A-Za-z_][\w-]*\s*\{/u.exec(text.slice(index))
      if (head === null) {
        errors.push(`${where}: keyframes may only hold @keyframes blocks`)
        return
      }
      index += head[0].length
      depth = 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth < 0) break
    index += 1
  }
  if (depth !== 0) errors.push(`${where}: keyframes have unbalanced braces`)
}

function checkScheme(value: unknown, where: string, errors: string[]): SchemeTheme | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !isRecord(value.colours)) {
    errors.push(`${where}: needs a colours object`)
    return undefined
  }
  const colours = new Map<ColourRole, string>()
  for (const role of [...NEUTRAL_ROLES, ...ACCENT_ROLES]) {
    const hex = value.colours[role]
    if (typeof hex === 'string' && HEX.test(hex)) colours.set(role, hex.toLowerCase())
    else errors.push(`${where}.colours.${role}: a #rrggbb colour is required (${ROLE_GUIDE[role]})`)
  }
  const syntax: Record<string, string> = {}
  if (value.syntax !== undefined) {
    if (!isRecord(value.syntax)) errors.push(`${where}.syntax: must be an object`)
    else
      for (const [role, hex] of Object.entries(value.syntax)) {
        if (!SYNTAX_ROLE_SET.has(role)) errors.push(`${where}.syntax.${role}: unknown role (${SYNTAX_ROLES.join(', ')})`)
        else if (typeof hex !== 'string' || !HEX.test(hex)) errors.push(`${where}.syntax.${role}: a #rrggbb colour is required`)
        else syntax[role] = hex.toLowerCase()
      }
  }
  let backdrop: Backdrop | undefined
  if (value.backdrop !== undefined) {
    const raw = value.backdrop
    if (!isRecord(raw) || !Array.isArray(raw.layers) || raw.layers.length === 0 || raw.layers.length > MAX_BACKDROP_LAYERS)
      errors.push(`${where}.backdrop: needs 1 to ${MAX_BACKDROP_LAYERS} layers`)
    else {
      const layers: string[] = []
      raw.layers.forEach((layer, index) => {
        if (typeof layer !== 'string' || layer.trim() === '') errors.push(`${where}.backdrop.layers[${index}]: CSS declarations are required`)
        else if (layer.length > MAX_LAYER_LENGTH) errors.push(`${where}.backdrop.layers[${index}]: longer than ${MAX_LAYER_LENGTH} characters`)
        else if (/[{}]/u.test(layer) || FORBIDDEN.test(layer))
          errors.push(`${where}.backdrop.layers[${index}]: declarations only, without braces, url() or @import`)
        else layers.push(layer.trim())
      })
      if (raw.keyframes !== undefined && typeof raw.keyframes !== 'string') errors.push(`${where}.backdrop.keyframes: must be a string`)
      else if (typeof raw.keyframes === 'string') checkKeyframes(raw.keyframes, errors, `${where}.backdrop`)
      backdrop = typeof raw.keyframes === 'string' && raw.keyframes.trim() !== '' ? { layers, keyframes: raw.keyframes.trim() } : { layers }
    }
  }
  const full = completeColours(colours)
  if (full === undefined) return undefined
  let scheme: SchemeTheme = { colours: full }
  if (Object.keys(syntax).length > 0) scheme = { ...scheme, syntax }
  if (backdrop !== undefined) scheme = { ...scheme, backdrop }
  return scheme
}

/** Every colour role, or undefined when one is missing (its error is already recorded). */
function completeColours(colours: ReadonlyMap<ColourRole, string>): SchemeTheme['colours'] | undefined {
  const get = (role: ColourRole): string => colours.get(role) ?? ''
  if ([...NEUTRAL_ROLES, ...ACCENT_ROLES].some(role => get(role) === '')) return undefined
  return {
    bg: get('bg'),
    panel: get('panel'),
    raised: get('raised'),
    selected: get('selected'),
    line: get('line'),
    border: get('border'),
    borderStrong: get('borderStrong'),
    strong: get('strong'),
    faint: get('faint'),
    muted: get('muted'),
    text: get('text'),
    accent: get('accent'),
    onAccent: get('onAccent'),
    success: get('success'),
    warning: get('warning'),
    danger: get('danger'),
    info: get('info'),
  }
}

/** The result of parsing untrusted theme data. */
export interface ParsedDefinition {
  readonly definition?: ThemeDefinition
  readonly errors: readonly string[]
}

/** A definition parsed from untrusted data (settings, an agent tool): the definition, or every problem found. */
function parseDefinition(value: unknown, reservedIds: readonly string[] = []): ParsedDefinition {
  const errors: string[] = []
  if (!isRecord(value)) return { errors: ['a theme must be an object'] }
  const id = typeof value.id === 'string' ? value.id : ''
  if (!ID.test(id)) errors.push('id: lowercase letters, digits and hyphens, at most 48 characters')
  else if (reservedIds.includes(id)) errors.push(`id: "${id}" is a built-in preset; pick another id`)
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (label === '' || label.length > 60) errors.push('label: 1 to 60 characters')
  if (value.description !== undefined && typeof value.description !== 'string') errors.push('description: must be a string')
  const dark = checkScheme(value.dark, 'dark', errors)
  const light = checkScheme(value.light, 'light', errors)
  if (value.dark === undefined && value.light === undefined) errors.push('give at least one scheme: dark, light or both')
  if (errors.length > 0) return { errors }
  const description = typeof value.description === 'string' ? value.description.trim().slice(0, 200) : ''
  let definition: ThemeDefinition = { id, label }
  if (description !== '') definition = { ...definition, description }
  if (dark !== undefined) definition = { ...definition, dark }
  if (light !== undefined) definition = { ...definition, light }
  return { errors, definition }
}

/**
 * The text pairs below WCAG AA in a definition, as plain sentences; empty when every pair passes. A theme with
 * warnings still applies (an official palette may sit just under AA); the agent shows them so the user can decide.
 */
function contrastWarnings(definition: ThemeDefinition): string[] {
  const warnings: string[] = []
  for (const scheme of ['dark', 'light'] as const) {
    const theme = definition[scheme]
    if (theme === undefined) continue
    const c = theme.colours
    const ratio = (a: string, b: string) => PaletteMath.contrastRatio(PaletteMath.hexToOklch(a), PaletteMath.hexToOklch(b))
    const check = (role: string, colour: string, min: number) => {
      for (const surface of ['bg', 'panel', 'raised'] as const) {
        const value = ratio(colour, c[surface])
        if (value < min) warnings.push(`${scheme}: ${role} on ${surface} is ${value.toFixed(2)}:1 (needs ${min}:1)`)
      }
    }
    check('text', c.text, 4.5)
    check('muted', c.muted, 4.5)
    check('faint', c.faint, 3)
    for (const role of ['accent', 'success', 'warning', 'danger', 'info'] as const) check(role, c[role], 4.5)
    const onAccent = ratio(c.onAccent, c.accent)
    if (onAccent < 4.5) warnings.push(`${scheme}: onAccent on accent is ${onAccent.toFixed(2)}:1 (needs 4.5:1)`)
    for (const [role, colour] of Object.entries(theme.syntax ?? {})) {
      if (role === 'comment') continue
      const value = ratio(colour, c.panel)
      if (value < 4.5) warnings.push(`${scheme}: syntax ${role} on panel is ${value.toFixed(2)}:1 (needs 4.5:1)`)
    }
  }
  return warnings
}

/** The generator input a definition starts from: the hue and tint of its background, the hue of its accent. */
function baseInput(definition: ThemeDefinition): Omit<PaletteInput, 'scheme'> {
  const theme = definition.dark ?? definition.light
  // parseDefinition guarantees at least one scheme; a hand-built definition without one gets the default hues.
  if (theme === undefined) return { hue: 65, chroma: 0.007, accentHue: 270, contrast: 1 }
  const bg = PaletteMath.hexToOklch(theme.colours.bg)
  const accent = PaletteMath.hexToOklch(theme.colours.accent)
  const round = (value: number, digits: number) => Number(value.toFixed(digits))
  return { hue: round(bg.h, 1), chroma: round(Math.min(0.03, bg.c), 4), accentHue: round(accent.h, 1), contrast: 1 }
}

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`
}

function pins(theme: SchemeTheme): string[] {
  const out: string[] = []
  const push = (name: string, value: string) => out.push(`  ${name}: ${value};`)
  NEUTRAL_ROLES.forEach((role, step) => push(`--dshx-tone-${step}`, theme.colours[role]))
  push('--dshx-tone-accent', theme.colours.accent)
  push('--dshx-tone-accent-bg', rgba(theme.colours.accent, 0.14))
  push('--dshx-tone-accent-border', rgba(theme.colours.accent, 0.35))
  push('--dshx-tone-accent-on-solid', theme.colours.onAccent)
  for (const role of ['success', 'warning', 'danger', 'info'] as const) {
    push(`--dshx-tone-${role}`, theme.colours[role])
    push(`--dshx-tone-${role}-bg`, rgba(theme.colours[role], 0.12))
    push(`--dshx-tone-${role}-border`, rgba(theme.colours[role], 0.3))
  }
  for (const [role, colour] of Object.entries(theme.syntax ?? {})) {
    push(`--shiki-token-${role}`, colour)
    if (role === 'string') push('--shiki-token-string-expression', colour)
  }
  return out
}

/** The main workbench: the conversation and its tabs, never the sidebars, dialogs or the composer. */
export const BACKDROP_HOST = '[data-workbench-region="main"] .dshfiles-workbench-theme'

function backdropCss(scope: string, backdrop: Backdrop): string {
  const host = `${scope} ${BACKDROP_HOST}`
  // Three pseudo-elements host the layers: two on the shell, one on its dockview; all sit under the content.
  const slots = [`${host}::before`, `${host} .dv-dockview::before`, `${host}::after`]
  const blocks = [
    // The shell becomes the backdrop's stacking context; its dockview surfaces turn transparent so the layers show.
    `${host} {`,
    '  isolation: isolate;',
    '  --dv-group-view-background-color: transparent;',
    '  --dv-tabs-and-actions-container-background-color: transparent;',
    '  --dv-activegroup-visiblepanel-tab-background-color: transparent;',
    '  --dv-inactivegroup-visiblepanel-tab-background-color: transparent;',
    '}',
  ]
  backdrop.layers.forEach((layer, index) => {
    const declarations = layer
      .split(';')
      .map(part => part.trim())
      .filter(part => part !== '')
      .map(part => `  ${part};`)
    blocks.push(
      [
        `${slots[index]} {`,
        "  content: '';",
        '  position: absolute;',
        '  inset: 0;',
        `  z-index: ${index - 3};`,
        '  pointer-events: none;',
        ...declarations,
        '}',
      ].join('\n'),
    )
  })
  if (backdrop.keyframes !== undefined) blocks.push(backdrop.keyframes)
  const used = slots.slice(0, backdrop.layers.length).join(', ')
  blocks.push('@media (prefers-reduced-motion: reduce) {', `  ${used} { animation: none !important; }`, '}')
  return blocks.join('\n')
}

/**
 * The CSS a definition adds after the generated blocks: per scheme, the pins under the runtime selector and the backdrop.
 * The light backdrop is guarded so it never shows in dark.
 */
function definitionCss(definition: ThemeDefinition, selectors: { readonly light: string; readonly dark: string }): string {
  const parts: string[] = []
  for (const scheme of ['light', 'dark'] as const satisfies readonly Scheme[]) {
    const theme = definition[scheme]
    if (theme === undefined) continue
    const selector = selectors[scheme]
    parts.push([`${selector} {`, ...pins(theme), '}'].join('\n'))
    if (theme.backdrop !== undefined) parts.push(backdropCss(scheme === 'light' ? `${selector}:not([data-ds-dark-theme])` : selector, theme.backdrop))
  }
  return parts.join('\n\n')
}

/** Theme definitions: parsing, contrast report, generator input and CSS. */
export class ThemeDefinitionModel {
  static readonly parse = parseDefinition
  static readonly contrastWarnings = contrastWarnings
  static readonly baseInput = baseInput
  static readonly css = definitionCss
}
