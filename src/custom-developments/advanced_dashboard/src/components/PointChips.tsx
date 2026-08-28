import { Cross2Icon } from '@radix-ui/react-icons'

interface PointChipsProps {
  points: string[]
  onRemove: (pointName: string) => void
  onClear: () => void
}

/**
 * The selection, shown once above every view rather than repeated per chart.
 */
export function PointChips({ points, onRemove, onClear }: PointChipsProps) {
  if (points.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-3">
        {points.length} selected
      </span>
      {points.map((point) => (
        <span
          key={point}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-surface-2 py-1 pl-3 pr-1.5 text-xs text-ink-2"
        >
          <span className="truncate font-medium">{point}</span>
          <button
            type="button"
            onClick={() => onRemove(point)}
            aria-label={`Remove ${point}`}
            title={`Remove ${point}`}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-1 hover:text-status-critical focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-series-1"
          >
            <Cross2Icon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="rounded px-2 py-1 text-xs font-medium text-ink-3 underline-offset-2 transition-colors hover:text-ink-1 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-series-1"
      >
        Clear all
      </button>
    </div>
  )
}
