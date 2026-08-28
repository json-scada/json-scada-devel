import { formatTick, viz } from '../../lib/viz'

const START_ANGLE = 150
const SWEEP = 240
const SIZE = 168
const STROKE = 9
/** Room under the arc for the endpoint labels. */
const HEIGHT = SIZE * 0.88

interface ArcGaugeProps {
  value: number
  min: number
  max: number
  /** Rendered inside the arc; already formatted by the caller. */
  display: string
  /** Dim the fill when the reading is not trustworthy. */
  muted?: boolean
}

/**
 * Bounded meter with labelled endpoints. The track is a darker step of the
 * series ramp rather than a neutral, so the state reads across the whole arc.
 */
export function ArcGauge({ value, min, max, display, muted }: ArcGaugeProps) {
  const span = max - min || 1
  const fraction = clamp((value - min) / span, 0, 1)
  const center = SIZE / 2
  const radius = center - STROKE / 2 - 2

  const trackPath = arc(center, center, radius, START_ANGLE, SWEEP)
  const valuePath = arc(center, center, radius, START_ANGLE, SWEEP * fraction)
  const ends = {
    left: polar(center, center, radius, START_ANGLE),
    right: polar(center, center, radius, START_ANGLE + SWEEP),
  }

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${HEIGHT}`}
      className="mx-auto w-full max-w-[236px]"
      role="img"
      aria-label={`${display}, on a scale from ${formatTick(min)} to ${formatTick(max)}`}
    >
      <path
        d={trackPath}
        fill="none"
        stroke={viz.series1Track}
        strokeWidth={STROKE}
        strokeLinecap="round"
        opacity={muted ? 0.4 : 1}
      />
      {fraction > 0 && (
        <path
          d={valuePath}
          fill="none"
          stroke={muted ? viz.ink3 : viz.series1}
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
      )}

      <text
        x={center}
        y={center + 6}
        textAnchor="middle"
        fill={muted ? viz.ink3 : viz.ink1}
        fontSize={22}
        fontWeight={600}
      >
        {display}
      </text>

      {/* Endpoints sit clear of the arc so the scale is never in doubt. */}
      <text
        x={ends.left.x}
        y={ends.left.y + 16}
        textAnchor="middle"
        fill={viz.ink3}
        fontSize={9}
      >
        {formatTick(min)}
      </text>
      <text
        x={ends.right.x}
        y={ends.right.y + 16}
        textAnchor="middle"
        fill={viz.ink3}
        fontSize={9}
      >
        {formatTick(max)}
      </text>
    </svg>
  )
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}

function arc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  sweep: number
): string {
  const endAngle = startAngle + sweep
  const start = polar(cx, cy, r, startAngle)
  const end = polar(cx, cy, r, endAngle)
  const largeArc = sweep > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}
