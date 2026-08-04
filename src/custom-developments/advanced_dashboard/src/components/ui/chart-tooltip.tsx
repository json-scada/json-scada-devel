export interface TooltipRow {
  label?: string
  value: string
}

interface ChartTooltipProps {
  title: string
  rows: TooltipRow[]
}

/** Shared tooltip shell, so every chart reads the same on hover and on focus. */
export function ChartTooltip({ title, rows }: ChartTooltipProps) {
  return (
    <div className="pointer-events-none rounded-md border border-hairline bg-surface-2 px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-ink-1">{title}</p>
      <dl className="mt-1 space-y-0.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-baseline gap-3 text-xs">
            {row.label && <dt className="text-ink-3">{row.label}</dt>}
            <dd className="ml-auto tabular-nums text-ink-2">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
