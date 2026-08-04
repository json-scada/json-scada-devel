// Tokens and formatting helpers shared by the transformer diagram and the
// readout tiles. The palette is the same cool-neutral control-room scale used
// by the advanced_dashboard example, plus two voltage-level hues for the
// single-line drawing.
//
// Keep the hex values in sync with the `colors` block of tailwind.config.mjs,
// which exposes the same tokens to Tailwind utility classes.

export const viz = {
  /** Page plane, behind the cards. */
  surface0: '#0b0e11',
  /** Card / diagram surface. */
  surface1: '#14181c',
  /** Raised rows, chips, table stripes. */
  surface2: '#1b2026',
  ink1: '#ffffff',
  ink2: '#c6cbd1',
  /** Labels and secondary copy. */
  ink3: '#8b929b',
  /** Hairline rule, one step off the surface. */
  grid: '#232930',
  /** Steelwork, flanges, tank outline. */
  metal: '#3a444f',
  metalLight: '#586472',
  /** 230 kV conductors, HV winding. */
  hv: '#f0a04b',
  /** 69 kV conductors, LV winding. */
  lv: '#4f9df7',
  /** Conductor with the bay breaker open, or with bad data behind it. */
  deenergized: '#4b555f',
  /** Insulating oil. */
  oil: '#8a6a2f',
} as const

/** Reserved state scale. Never used for equipment identity. */
export const status = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

export type Tone = 'good' | 'warning' | 'critical' | 'unknown'

export interface QualityInfo {
  tone: Tone
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

export function isGood(quality: number | undefined | null): boolean {
  return qualityInfo(quality).tone === 'good'
}

/** Worst quality of a set of points, so a side can be judged as a whole. */
export function worstQuality(
  qualities: (number | undefined | null)[]
): number | undefined {
  const order: Record<Tone, number> = {
    good: 0,
    warning: 1,
    unknown: 2,
    critical: 3,
  }
  let worst: number | undefined
  let worstRank = -1
  for (const quality of qualities) {
    const rank = order[qualityInfo(quality).tone]
    if (rank > worstRank) {
      worstRank = rank
      worst = typeof quality === 'number' ? quality : undefined
    }
  }
  return worst
}

/** Fixed-decimal measurement, with an em dash when there is nothing to show. */
export function formatValue(
  value: number | null | undefined,
  digits = 1
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function formatClock(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString(undefined, { hour12: false })
}

/** "12 s ago" / "3 min ago", for row timestamps that are usually recent. */
export function formatAgo(date: Date | null | undefined, now: number): string {
  if (!date || Number.isNaN(date.getTime())) return '—'
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Clamp a value into [0, 1] for meters and scales. */
export function fraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max === min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}
