import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { qualityInfo, type Tone } from '@/lib/viz'

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-ink-1',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  unknown: 'text-ink-3',
}

interface StatProps {
  label: string
  value: string
  unit?: string
  /** OPC status code of the underlying tag; drives the quality footnote. */
  quality?: number
  /** Alarm state of the *value* itself, independent of its quality. */
  tone?: Tone
  hint?: string
  className?: string
}

/**
 * One measurement. Value tone carries the alarm state, the footnote carries the
 * data quality — never the same channel, so neither one is read by colour alone.
 */
export function Stat({
  label,
  value,
  unit,
  quality,
  tone = 'good',
  hint,
  className,
}: StatProps) {
  const info = qualityInfo(quality)
  const suspect = info.tone !== 'good'
  return (
    <div
      className={cn(
        'rounded-md border border-hairline bg-surface-2 px-3 py-2',
        className
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            'font-mono text-xl tabular-nums leading-none',
            suspect ? 'text-ink-3' : TONE_TEXT[tone]
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[11px] text-ink-3">{unit}</span>}
      </div>
      {(hint || suspect) && (
        <div
          className={cn(
            'mt-1 text-[10px]',
            suspect ? 'text-status-warning' : 'text-ink-3'
          )}
        >
          {suspect ? info.label : hint}
        </div>
      )}
    </div>
  )
}

interface StatGridProps {
  children: ReactNode
  className?: string
}

export function StatGrid({ children, className }: StatGridProps) {
  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>{children}</div>
  )
}
