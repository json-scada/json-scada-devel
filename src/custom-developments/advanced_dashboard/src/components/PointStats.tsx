import { Cross2Icon } from '@radix-ui/react-icons'
import type { DataPoint } from '../lib/scadaOpcApi'
import { formatValue, qualityInfo, viz } from '../lib/viz'
import { QualityPill } from './ui/status'

interface PointStatsProps {
  points: DataPoint[]
  trends: Record<string, number[]>
  onRemove: (pointName: string) => void
}

/**
 * Current value per tag. A single number is the whole story here, so it gets a
 * stat tile rather than a one-bar chart, and it doubles as the table-view twin
 * for the bar chart below it.
 */
export function PointStats({ points, trends, onRemove }: PointStatsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {points.map((point) => (
        <StatTile
          key={point.name}
          point={point}
          trend={trends[point.name] ?? []}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

interface StatTileProps {
  point: DataPoint
  trend: number[]
  onRemove: (pointName: string) => void
}

function StatTile({ point, trend, onRemove }: StatTileProps) {
  const suspect = qualityInfo(point.quality).tone !== 'good'
  const delta =
    trend.length > 1 ? trend[trend.length - 1] - trend[0] : null

  return (
    <article className="group relative rounded-lg border border-hairline bg-surface-1 p-4">
      <button
        type="button"
        onClick={() => onRemove(point.name)}
        aria-label={`Remove ${point.name}`}
        title={`Remove ${point.name}`}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-ink-3 opacity-0 transition-opacity hover:bg-surface-2 hover:text-status-critical focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-series-1 group-hover:opacity-100"
      >
        <Cross2Icon className="h-3.5 w-3.5" />
      </button>

      <h3
        className="truncate pr-6 text-xs font-medium text-ink-3"
        title={point.name}
      >
        {point.name}
      </h3>

      <div className="mt-2 flex items-end justify-between gap-3">
        <p
          className={`text-3xl font-semibold leading-none ${suspect ? 'text-ink-3' : 'text-ink-1'}`}
        >
          {point.valueString || formatValue(point.value)}
        </p>
        <Sparkline values={trend} muted={suspect} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <QualityPill quality={point.quality} />
        {delta !== null && delta !== 0 && (
          <span
            className="text-xs tabular-nums text-ink-3"
            title="Change across the live window"
          >
            {delta > 0 ? '▲' : '▼'} {formatValue(Math.abs(delta))}
          </span>
        )}
      </div>
    </article>
  )
}

interface SparklineProps {
  values: number[]
  muted: boolean
}

/** Live-window trend. Recessive by design: the number is the headline. */
function Sparkline({ values, muted }: SparklineProps) {
  const width = 88
  const height = 28

  if (values.length < 2) {
    return <div style={{ width, height }} aria-hidden />
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const y = (value: number) =>
    height - 2 - ((value - min) / span) * (height - 4)

  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${index * step},${y(value)}`)
    .join(' ')

  const lastX = (values.length - 1) * step
  const lastY = y(values[values.length - 1])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={`Trend over the last ${values.length} readings`}
    >
      <path
        d={path}
        fill="none"
        stroke={muted ? viz.axis : viz.series1Track}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 2px surface ring keeps the end marker legible where it meets the line. */}
      <circle cx={lastX} cy={lastY} r={4} fill={viz.surface1} />
      <circle
        cx={lastX}
        cy={lastY}
        r={2.5}
        fill={muted ? viz.ink3 : viz.series1}
      />
    </svg>
  )
}
