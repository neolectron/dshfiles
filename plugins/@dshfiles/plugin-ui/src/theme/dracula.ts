/**
 * The Dracula preset's dark scheme (https://draculatheme.com/contribute#color-palette): the generator gives Dracula's
 * hue and purple accent to light mode and to every Host ramp, then these pins put the official colours on the eleven
 * steps, the status trios and the Shiki tokens, and paint a night sky (twinkling stars, a violet moon) behind the main
 * workbench. Pins and scene apply only while the preset is unmodified: a grey, accent or contrast override is a
 * request for the generated palette instead.
 */

/** The official Dracula palette. */
export const DRACULA = {
  background: '#282a36',
  currentLine: '#44475a',
  foreground: '#f8f8f2',
  comment: '#6272a4',
  cyan: '#8be9fd',
  green: '#50fa7b',
  orange: '#ffb86c',
  pink: '#ff79c6',
  purple: '#bd93f9',
  red: '#ff5555',
  yellow: '#f1fa8c',
} as const

/**
 * The eleven neutral steps (see `Palette.neutral`). Steps 1–2 are the darker sidebar and the lighter raised fill of
 * the Dracula editor themes; 8 and 9 lift the comment blue and a foreground grey until they read on the raised fill.
 */
export const DRACULA_NEUTRAL: readonly string[] = [
  DRACULA.background,
  '#21222c',
  '#343746',
  DRACULA.currentLine,
  '#3b3e51',
  DRACULA.currentLine,
  '#565a73',
  DRACULA.comment,
  '#7f8bbd',
  '#c0c2d4',
  DRACULA.foreground,
]

/**
 * Status text colours. Dracula's red and green are pinned as-is where they read; red falls to 3.8:1 on the raised
 * fill, so text uses the theme's bright red (`#ff6e6e` in the terminal ports) lifted one notch further.
 */
export const DRACULA_STATUS = { success: DRACULA.green, warning: DRACULA.orange, danger: '#ff7b7b', info: DRACULA.cyan } as const

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`
}

function pinDeclarations(): string[] {
  const out: string[] = []
  const push = (name: string, value: string) => out.push(`  ${name}: ${value};`)
  DRACULA_NEUTRAL.forEach((hex, step) => push(`--dshx-tone-${step}`, hex))
  push('--dshx-tone-accent', DRACULA.purple)
  push('--dshx-tone-accent-bg', rgba(DRACULA.purple, 0.14))
  push('--dshx-tone-accent-border', rgba(DRACULA.purple, 0.35))
  push('--dshx-tone-accent-on-solid', DRACULA.background)
  for (const [key, hex] of Object.entries(DRACULA_STATUS)) {
    push(`--dshx-tone-${key}`, hex)
    push(`--dshx-tone-${key}-bg`, rgba(hex, 0.12))
    push(`--dshx-tone-${key}-border`, rgba(hex, 0.3))
  }
  push('--shiki-token-comment', DRACULA.comment)
  push('--shiki-token-punctuation', DRACULA.foreground)
  push('--shiki-token-constant', DRACULA.purple)
  push('--shiki-token-keyword', DRACULA.pink)
  push('--shiki-token-parameter', DRACULA.orange)
  push('--shiki-token-function', DRACULA.green)
  push('--shiki-token-string', DRACULA.yellow)
  push('--shiki-token-string-expression', DRACULA.yellow)
  return out
}

/** A star: x and y inside its tile (px), radius (px), alpha. */
type Star = readonly [x: number, y: number, r: number, a: number]

/**
 * Star tiles. Prime tile sizes stop the repeats from lining up into a visible grid; each layer is one tile size with
 * a few stars at fixed positions, so the field is the same on every reload and costs nothing to compute.
 */
const STATIC_STARS: ReadonlyArray<readonly [tile: number, stars: readonly Star[]]> = [
  [
    173,
    [
      [23, 41, 0.8, 0.55],
      [131, 117, 0.7, 0.45],
      [88, 152, 0.6, 0.4],
    ],
  ],
  [
    251,
    [
      [61, 199, 0.9, 0.6],
      [202, 37, 0.7, 0.5],
    ],
  ],
  [
    337,
    [
      [289, 263, 1, 0.7],
      [117, 83, 0.8, 0.5],
    ],
  ],
]
const TWINKLE_A: ReadonlyArray<readonly [number, readonly Star[]]> = [
  [
    199,
    [
      [47, 67, 1.1, 0.95],
      [163, 151, 0.9, 0.8],
    ],
  ],
  [
    313,
    [
      [241, 29, 1.3, 1],
      [97, 233, 1, 0.85],
    ],
  ],
]
const TWINKLE_B: ReadonlyArray<readonly [number, readonly Star[]]> = [
  [
    227,
    [
      [181, 97, 1.1, 0.9],
      [29, 191, 0.9, 0.8],
    ],
  ],
  [
    379,
    [
      [331, 307, 1.4, 1],
      [149, 41, 1, 0.85],
    ],
  ],
]

/** Star glow: white with a hint of Dracula's cyan and pink so the field is not flat grey. */
const STAR_TINTS = ['248 248 242', '214 240 255', '255 226 244'] as const

function starLayers(layers: ReadonlyArray<readonly [number, readonly Star[]]>): { images: string[]; sizes: string[] } {
  const images: string[] = []
  const sizes: string[] = []
  layers.forEach(([tile, stars], layer) => {
    stars.forEach(([x, y, r, a], index) => {
      const tint = STAR_TINTS[(layer + index) % STAR_TINTS.length] ?? STAR_TINTS[0]
      images.push(`radial-gradient(circle at ${x}px ${y}px, rgb(${tint} / ${a}) 0, rgb(${tint} / ${a}) ${r}px, rgb(${tint} / 0) ${(r * 2.4).toFixed(1)}px)`)
      sizes.push(`${tile}px ${tile}px`)
    })
  })
  return { images, sizes }
}

/** The violet moon in the top-right corner, below the thread header: a soft halo, the disc, and three craters. */
const MOON = [
  'radial-gradient(circle at calc(100% - 136px) 178px, rgb(255 255 255 / 0.35) 0, rgb(255 255 255 / 0) 9px)',
  'radial-gradient(circle at calc(100% - 158px) 198px, rgb(98 74 158 / 0.45) 0, rgb(98 74 158 / 0.45) 6px, rgb(98 74 158 / 0) 8px)',
  'radial-gradient(circle at calc(100% - 132px) 206px, rgb(98 74 158 / 0.35) 0, rgb(98 74 158 / 0.35) 4px, rgb(98 74 158 / 0) 6px)',
  'radial-gradient(circle at calc(100% - 168px) 172px, rgb(98 74 158 / 0.3) 0, rgb(98 74 158 / 0.3) 3px, rgb(98 74 158 / 0) 5px)',
  `radial-gradient(circle at calc(100% - 150px) 190px, #e4d2ff 0, #c9a6ff 24px, ${DRACULA.purple} 38px, rgb(189 147 249 / 0) 39.5px)`,
  'radial-gradient(circle at calc(100% - 150px) 190px, rgb(189 147 249 / 0.28) 36px, rgb(189 147 249 / 0.1) 70px, rgb(189 147 249 / 0) 150px)',
]

/** The main workbench: the conversation and its tabs, never the sidebars, dialogs or the composer. */
const SCENE_HOST = '[data-workbench-region="main"] .dshfiles-workbench-theme'

function sceneCss(dark: string): string {
  const scope = `${dark} ${SCENE_HOST}`
  const base = starLayers(STATIC_STARS)
  const twinkleA = starLayers(TWINKLE_A)
  const twinkleB = starLayers(TWINKLE_B)
  const sky = `linear-gradient(180deg, #1d1e27 0%, ${DRACULA.background} 70%)`
  const layer = (selector: string, images: readonly string[], sizes: readonly string[], extra: readonly string[]) =>
    [
      `${selector} {`,
      "  content: '';",
      '  position: absolute;',
      '  inset: 0;',
      '  z-index: -1;',
      '  pointer-events: none;',
      `  background-image: ${images.join(',\n    ')};`,
      `  background-size: ${sizes.join(', ')};`,
      ...extra.map(line => `  ${line}`),
      '}',
    ].join('\n')
  return [
    // The shell becomes the sky's stacking context; its dockview surfaces turn transparent so the sky shows through.
    `${scope} {`,
    '  isolation: isolate;',
    '  --dv-group-view-background-color: transparent;',
    '  --dv-tabs-and-actions-container-background-color: transparent;',
    '  --dv-activegroup-visiblepanel-tab-background-color: transparent;',
    '  --dv-inactivegroup-visiblepanel-tab-background-color: transparent;',
    '}',
    layer(
      `${scope}::before`,
      [...MOON, ...base.images, sky],
      [...MOON.map(() => 'auto'), ...base.sizes, 'auto'],
      [`background-repeat: ${[...MOON.map(() => 'no-repeat'), ...base.sizes.map(() => 'repeat'), 'no-repeat'].join(', ')};`],
    ),
    layer(`${scope}::after`, twinkleA.images, twinkleA.sizes, ['animation: dshx-dracula-twinkle 3.7s ease-in-out infinite alternate;']),
    layer(`${scope} .dv-dockview::after`, twinkleB.images, twinkleB.sizes, ['animation: dshx-dracula-twinkle 5.3s ease-in-out -2.1s infinite alternate;']),
    // Only opacity animates: the layers composite on the GPU and nothing repaints per frame.
    '@keyframes dshx-dracula-twinkle {',
    '  from { opacity: 0.15; }',
    '  to { opacity: 1; }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    `  ${scope}::after, ${scope} .dv-dockview::after { animation: none; opacity: 0.6; }`,
    '}',
  ].join('\n')
}

/** The Dracula dark pins and scene under the runtime dark selector, appended after the generated blocks. */
function draculaCss(darkSelector: string): string {
  return [[`${darkSelector} {`, ...pinDeclarations(), '}'].join('\n'), sceneCss(darkSelector)].join('\n\n')
}

/** Dracula's exact dark palette and night-sky backdrop. */
export class DraculaTheme {
  static readonly css = draculaCss
}
