// Visualization tokens and formatting helpers shared by every chart.
//
// The palette was validated against the card surface (#14181c) in dark mode:
// lightness band, chroma floor, CVD separation (worst all-pairs deltaE 9.4) and
// contrast (>= 3.7:1 for every mark and status colour) all pass.
//
// Keep the hex values in sync with the `colors` block of tailwind.config.mjs,
// which exposes the same tokens to Tailwind utility classes.

export const viz = {
  /** Page plane, behind the cards. */
  surface0: '#0b0e11',
  /** Card / chart surface. Every contrast figure above is measured on this. */
  surface1: '#14181c',
  /** Raised rows, chips, table stripes. */
  surface2: '#1b2026',
  ink1: '#ffffff',
  ink2: '#c6cbd1',
  /** Axis labels and secondary copy. */
  ink3: '#8b929b',
  /** Hairline gridline, one step off the surface. */
  grid: '#232930',
  /** Baseline / axis rule. */
  axis: '#333b44',
  /** Categorical slot 1. Every chart here plots a single series. */
  series1: '#3987e5',
  /** Unfilled meter track: a step of the series ramp, not a neutral gray. */
  series1Track: '#184f95',
} as const

/** Reserved state scale. Never used for series identity. */
export const status = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

export type QualityTone = 'good' | 'warning' | 'critical' | 'unknown'

export interface QualityInfo {
  tone: QualityTone
  label: string
  color: string
}

/**
 * Map an OPC status code to a state. The top two bits of the code carry the
 * severity: 00 good, 01 uncertain, 10/11 bad.
 */
export function qualityInfo(quality: number | undefined | null): QualityInfo {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) {
    return { tone: 'unknown', label: 'No data', color: viz.ink3 }
  }
  switch ((quality >>> 30) & 0b11) {
    case 0:
      return { tone: 'good', label: 'Good', color: status.good }
    case 1:
      return { tone: 'warning', label: 'Uncertain', color: status.warning }
    default:
      return { tone: 'critical', label: 'Bad', color: status.critical }
  }
}

/** Colour a mark should take: the series hue, dimmed when the value is suspect. */
export function markColor(quality: number | undefined | null): string {
  return qualityInfo(quality).tone === 'good' ? viz.series1 : viz.ink3
}

/**
 * Format a measurement for display. Keeps full precision up to a million and
 * falls back to a compact form beyond it, so a stat tile never wraps.
 */
export function formatValue(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value)
}

/** Short axis tick label: no grouping separators, so ticks stay narrow. */
export function formatTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (magnitude >= 1e4) return `${(value / 1e3).toFixed(0)}k`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(magnitude < 10 ? 2 : 1)
}

export function formatClock(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString()
}

export function formatTimestamp(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString()
}

/**
 * Round a min/max pair out to readable endpoints so a gauge or meter never
 * shows an arbitrary scale. Anchors at zero for all-positive data.
 */
export function niceRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  let lo = Math.min(min, max)
  let hi = Math.max(min, max)
  if (lo >= 0) lo = 0
  if (hi <= 0) hi = 0
  if (lo === hi) {
    if (lo === 0) return [0, 1]
    return lo > 0 ? [0, lo * 2] : [lo * 2, 0]
  }
  const step = niceStep((hi - lo) / 4)
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step]
}

/**
 * Axis scale for a bar chart: anchored at zero, with clean ticks, and only as
 * much room below zero as the data actually needs. Recharts' automatic domain
 * reserves a whole step under the baseline, which throws away a quarter of the
 * plot when one tag dips slightly negative.
 */
export function barScale(values: number[]): {
  domain: [number, number]
  ticks: number[]
} {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return { domain: [0, 1], ticks: [0, 1] }

  const max = Math.max(0, ...finite)
  const min = Math.min(0, ...finite)
  const step = niceStep((max - min) / 5)

  const negStep = min < 0 ? niceStep(Math.abs(min)) : 0
  const low = min < 0 ? Math.floor(min / negStep) * negStep : 0
  const high = Math.max(Math.ceil(max / step) * step, low + step)

  const ticks: number[] = []
  for (let tick = 0; tick <= high + step / 2; tick += step) {
    ticks.push(Number(tick.toPrecision(12)))
  }
  return { domain: [low, high], ticks }
}

function niceStep(rough: number): number {
  const exponent = Math.floor(Math.log10(Math.abs(rough) || 1))
  const magnitude = Math.pow(10, exponent)
  const normalized = rough / magnitude
  if (normalized <= 1) return magnitude
  if (normalized <= 2) return 2 * magnitude
  if (normalized <= 5) return 5 * magnitude
  return 10 * magnitude
}
