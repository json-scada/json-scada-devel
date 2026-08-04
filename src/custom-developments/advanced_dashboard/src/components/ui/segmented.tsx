import { cn } from '../../lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Announced to assistive tech, e.g. "View" or "Time range". */
  label: string
  className?: string
}

/** Compact single-choice control used for view tabs and the time range. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex rounded-md border border-hairline bg-surface-2 p-0.5',
        className
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-series-1',
              selected ?
                'bg-series-1 text-white'
              : 'text-ink-3 hover:bg-surface-1 hover:text-ink-1'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
