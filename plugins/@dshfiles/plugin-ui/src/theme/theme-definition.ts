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
import { SCENE_IDS, SceneCatalog, type SceneGlass } from './scene-catalog.ts'

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
  /** A built-in animated scene (`SCENES` in scene-catalog.ts), painted first, at the back. */
  readonly scene?: string
  readonly layers?: readonly string[]
  readonly keyframes?: string
  /** A frosted layer over the scene and layers, under the conversation column: blur, tint and opacity. */
  readonly glass?: SceneGlass
}

export interface SchemeTheme {
  readonly colours: Readonly<Record<ColourRole, string>>
  readonly syntax?: Readonly<Partial<Record<SyntaxRole, string>>>
  readonly backdrop?: Backdrop
}

export interface ThemeDefinition {
  /** Lowercase letters, digits and hyphens; a built-in preset or gallery id is refused. */
  readonly id: string
  readonly label: string
  readonly description?: string
  /** At least one scheme. */
  readonly dark?: SchemeTheme
  readonly light?: SchemeTheme
}

export const MAX_BACKDROP_LAYERS = 3
/** Pseudo-elements that can hold a backdrop item (scene, layers, glass). */
const MAX_BACKDROP_ITEMS = 4
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
    const rawLayers: readonly unknown[] = isRecord(raw) && Array.isArray(raw.layers) ? raw.layers : []
    const scene = isRecord(raw) && typeof raw.scene === 'string' ? raw.scene : undefined
    const glass = isRecord(raw) ? checkGlass(raw.glass, `${where}.backdrop.glass`, errors) : undefined
    const items = rawLayers.length + (scene === undefined ? 0 : 1) + (glass === undefined ? 0 : 1)
    if (!isRecord(raw) || (isRecord(raw) && raw.layers !== undefined && !Array.isArray(raw.layers)))
      errors.push(`${where}.backdrop: must be an object with a scene, layers or both`)
    else if (raw.scene !== undefined && (scene === undefined || !SCENE_IDS.includes(scene)))
      errors.push(`${where}.backdrop.scene: one of ${SCENE_IDS.join(', ')}`)
    else if (scene === undefined && rawLayers.length === 0) errors.push(`${where}.backdrop: needs a scene or 1 to ${MAX_BACKDROP_LAYERS} layers`)
    else if (rawLayers.length > MAX_BACKDROP_LAYERS || items > MAX_BACKDROP_ITEMS)
      errors.push(`${where}.backdrop: at most ${MAX_BACKDROP_LAYERS} layers, and ${MAX_BACKDROP_ITEMS} items with the scene and the glass`)
    else {
      const layers: string[] = []
      rawLayers.forEach((layer, index) => {
        if (typeof layer !== 'string' || layer.trim() === '') errors.push(`${where}.backdrop.layers[${index}]: CSS declarations are required`)
        else if (layer.length > MAX_LAYER_LENGTH) errors.push(`${where}.backdrop.layers[${index}]: longer than ${MAX_LAYER_LENGTH} characters`)
        else if (/[{}]/u.test(layer) || FORBIDDEN.test(layer))
          errors.push(`${where}.backdrop.layers[${index}]: declarations only, without braces, url() or @import`)
        else layers.push(layer.trim())
      })
      if (raw.keyframes !== undefined && typeof raw.keyframes !== 'string') errors.push(`${where}.backdrop.keyframes: must be a string`)
      else if (typeof raw.keyframes === 'string') checkKeyframes(raw.keyframes, errors, `${where}.backdrop`)
      let parsed: Backdrop = {}
      if (scene !== undefined) parsed = { ...parsed, scene }
      if (layers.length > 0) parsed = { ...parsed, layers }
      if (typeof raw.keyframes === 'string' && raw.keyframes.trim() !== '') parsed = { ...parsed, keyframes: raw.keyframes.trim() }
      if (glass !== undefined) parsed = { ...parsed, glass }
      backdrop = parsed
    }
  }
  const full = completeColours(colours)
  if (full === undefined) return undefined
  let scheme: SchemeTheme = { colours: full }
  if (Object.keys(syntax).length > 0) scheme = { ...scheme, syntax }
  if (backdrop !== undefined) scheme = { ...scheme, backdrop }
  return scheme
}

function checkGlass(value: unknown, where: string, errors: string[]): SceneGlass | undefined {
  if (value === undefined) return undefined
  const inRange = (raw: unknown, min: number, max: number): raw is number => typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max
  if (!isRecord(value) || !inRange(value.blur, 0, 30) || !inRange(value.opacity, 0, 1) || typeof value.tint !== 'string' || !HEX.test(value.tint)) {
    errors.push(`${where}: blur 0–30, a #rrggbb tint and opacity 0–1`)
    return undefined
  }
  return { blur: value.blur, tint: value.tint.toLowerCase(), opacity: value.opacity }
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
  else if (reservedIds.includes(id)) errors.push(`id: "${id}" is a built-in theme; pick another id`)
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

/** Scene SVG sources by id, as the client has them; a scene not loaded yet is left out until it arrives. */
export type SceneSources = ReadonlyMap<string, string>

const declarationLines = (text: string): string[] =>
  text
    .split(';')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => `  ${part};`)

/**
 * The glass: a tint at its opacity over a blur of what lies under it, strongest under the conversation column and fading
 * out toward the sides, so the scene stays crisp at the edges as in Claude Code.
 */
function glassDeclarations(glass: SceneGlass): string[] {
  const fade = 'linear-gradient(90deg, transparent 0%, #000 22%, #000 78%, transparent 100%)'
  return [
    `  background-color: ${rgba(glass.tint, glass.opacity)};`,
    ...(glass.blur > 0 ? [`  backdrop-filter: blur(${glass.blur}px);`, `  -webkit-backdrop-filter: blur(${glass.blur}px);`] : []),
    `  mask-image: ${fade};`,
    `  -webkit-mask-image: ${fade};`,
  ]
}

/** A frosted panel behind the conversation column only, so a backdrop never runs under the text: none, soft or strong. */
export type ReadingPanel = 'off' | 'soft' | 'strong'
export const READING_PANELS = ['off', 'soft', 'strong'] as const satisfies readonly ReadingPanel[]

const PANEL_LEVELS = { soft: { opacity: 0.5, blur: 12 }, strong: { opacity: 0.8, blur: 22 } } as const

/**
 * The reading panel: the column's own width (the shared `--dsh-chat-content-width`, plus a margin), full height of the
 * conversation, centred like the column. It sits in the non-scrolling conversation body, made a stacking context so the
 * panel stays under every message and the composer and over the backdrop. Its sides fade so it reads as glass, not a card.
 */
function readingPanelCss(host: string, level: Exclude<ReadingPanel, 'off'>, tint: string): string {
  const { opacity, blur } = PANEL_LEVELS[level]
  const body = `${host} [data-conversation-content]`
  const fade = 'linear-gradient(90deg, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%)'
  return [
    `${body} {`,
    '  isolation: isolate;',
    '}',
    `${body}::before {`,
    "  content: '';",
    '  position: absolute;',
    '  top: 0;',
    '  bottom: 0;',
    '  left: 50%;',
    '  width: min(100%, calc(var(--dsh-chat-content-width, 760px) + 96px));',
    '  transform: translateX(-50%);',
    '  z-index: -1;',
    '  pointer-events: none;',
    `  background-color: ${rgba(tint, opacity)};`,
    `  backdrop-filter: blur(${blur}px) saturate(1.1);`,
    `  -webkit-backdrop-filter: blur(${blur}px) saturate(1.1);`,
    `  mask-image: ${fade};`,
    `  -webkit-mask-image: ${fade};`,
    '}',
  ].join('\n')
}

function backdropCss(scope: string, backdrop: Backdrop, scenes: SceneSources, panel: ReadingPanel, tint: string): string {
  const host = `${scope} ${BACKDROP_HOST}`
  // Four pseudo-elements host the items, back to front: two on the dockview between two on the shell, all under content.
  const slots = [`${host}::before`, `${host} .dv-dockview::before`, `${host} .dv-dockview::after`, `${host}::after`]
  const sceneSource = backdrop.scene === undefined ? undefined : scenes.get(backdrop.scene)
  const items: string[][] = []
  if (sceneSource !== undefined)
    items.push([
      '  background-image: ' + SceneCatalog.image(sceneSource) + ';',
      '  background-size: cover;',
      '  background-position: center;',
      '  background-repeat: no-repeat;',
    ])
  for (const layer of backdrop.layers ?? []) items.push(declarationLines(layer))
  if (backdrop.glass !== undefined) items.push(glassDeclarations(backdrop.glass))
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
  items.forEach((declarations, index) => {
    blocks.push(
      [
        `${slots[index]} {`,
        "  content: '';",
        '  position: absolute;',
        '  inset: 0;',
        `  z-index: ${index - MAX_BACKDROP_ITEMS};`,
        '  pointer-events: none;',
        ...declarations,
        '}',
      ].join('\n'),
    )
  })
  if (backdrop.keyframes !== undefined) blocks.push(backdrop.keyframes)
  if (panel !== 'off') blocks.push(readingPanelCss(host, panel, tint))
  const used = slots.slice(0, items.length).join(', ')
  const resting = sceneSource === undefined ? [] : [`  ${slots[0]} { background-image: ${SceneCatalog.image(SceneCatalog.resting(sceneSource))}; }`]
  blocks.push('@media (prefers-reduced-motion: reduce) {', `  ${used} { animation: none !important; }`, ...resting, '}')
  return blocks.join('\n')
}

/**
 * The CSS a definition adds after the generated blocks: per scheme, the pins under the runtime selector and the backdrop.
 * The light backdrop is guarded so it never shows in dark.
 */
function definitionCss(
  definition: ThemeDefinition,
  selectors: { readonly light: string; readonly dark: string },
  scenes: SceneSources = new Map(),
  panel: ReadingPanel = 'off',
): string {
  const parts: string[] = []
  for (const scheme of ['light', 'dark'] as const satisfies readonly Scheme[]) {
    const theme = definition[scheme]
    if (theme === undefined) continue
    const selector = selectors[scheme]
    parts.push([`${selector} {`, ...pins(theme), '}'].join('\n'))
    if (theme.backdrop !== undefined)
      parts.push(backdropCss(scheme === 'light' ? `${selector}:not([data-ds-dark-theme])` : selector, theme.backdrop, scenes, panel, theme.colours.bg))
  }
  return parts.join('\n\n')
}

/** The built-in scenes a definition paints, in either scheme. */
function scenesOf(definition: ThemeDefinition): string[] {
  const ids = [definition.dark?.backdrop?.scene, definition.light?.backdrop?.scene].filter(id => id !== undefined)
  return [...new Set(ids)]
}

/** Theme definitions: parsing, contrast report, generator input and CSS. */
export class ThemeDefinitionModel {
  static readonly parse = parseDefinition
  static readonly contrastWarnings = contrastWarnings
  static readonly baseInput = baseInput
  static readonly css = definitionCss
  static readonly scenesOf = scenesOf
}
