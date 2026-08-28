import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DataPoint } from '../lib/scadaOpcApi'
import {
  barScale,
  formatTick,
  formatValue,
  markColor,
  qualityInfo,
  viz,
} from '../lib/viz'
import { ChartTooltip } from './ui/chart-tooltip'

/** Cap-labels stop being readable once the bars get thin. */
const MAX_LABELLED_BARS = 10

interface RealTimeBarGraphProps {
  points: DataPoint[]
}

export function RealTimeBarGraph({ points }: RealTimeBarGraphProps) {
  const labelled = points.length <= MAX_LABELLED_BARS
  const scale = barScale(points.map((point) => point.value))

  return (
    <div className="h-[360px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={points}
          margin={{ top: 24, right: 8, bottom: 4, left: 0 }}
          barCategoryGap="25%"
        >
          <CartesianGrid
            stroke={viz.grid}
            strokeWidth={1}
            vertical={false}
          />
          <XAxis
            dataKey="name"
            interval={0}
            // Deep enough for the rotated labels: without it the axis band
            // clips their descending ends.
            height={64}
            tickLine={false}
            axisLine={{ stroke: viz.axis }}
            tick={<TagTick />}
          />
          <YAxis
            width={56}
            domain={scale.domain}
            ticks={scale.ticks}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTick}
            tick={{ fill: viz.ink3, fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as DataPoint
              return (
                <ChartTooltip
                  title={point.name}
                  rows={[
                    {
                      label: 'Value',
                      value: point.valueString || formatValue(point.value),
                    },
                    {
                      label: 'Quality',
                      value: qualityInfo(point.quality).label,
                    },
                  ]}
                />
              )
            }}
          />
          <Bar
            dataKey="value"
            maxBarSize={24}
            isAnimationActive={false}
            // A reading that is not "Good" is drawn in muted ink rather than
            // the series hue, so a suspect bar never reads as a healthy value.
            shape={({ x, y, width, height, payload }) => (
              <Rectangle
                x={x}
                y={y}
                width={width}
                height={height}
                radius={[4, 4, 0, 0]}
                fill={markColor((payload as DataPoint | undefined)?.quality)}
              />
            )}
          >
            {labelled && <LabelList dataKey="value" content={<ValueLabel />} />}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

interface ValueLabelProps {
  x?: number | string
  y?: number | string
  width?: number | string
  value?: number | string
}

/**
 * Always sits above the bar's upper edge. Recharts' built-in `position="top"`
 * drops the label below a negative bar, where it collides with the axis ticks.
 */
function ValueLabel({ x, y, width, value }: ValueLabelProps) {
  if (x === undefined || y === undefined || width === undefined) return null
  return (
    <text
      x={Number(x) + Number(width) / 2}
      y={Number(y) - 6}
      textAnchor="middle"
      fill={viz.ink2}
      fontSize={11}
    >
      {formatValue(Number(value))}
    </text>
  )
}

interface TagTickProps {
  x?: number
  y?: number
  payload?: { value?: string }
}

/**
 * Tag names are long. Truncate at the tick and keep the full name in the
 * tooltip and the stat tiles, rather than letting labels collide.
 */
function TagTick({ x = 0, y = 0, payload }: TagTickProps) {
  const raw = String(payload?.value ?? '')
  const text = raw.length > 14 ? `${raw.slice(0, 13)}…` : raw
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{raw}</title>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="end"
        transform="rotate(-35)"
        fill={viz.ink3}
        fontSize={11}
      >
        {text}
      </text>
    </g>
  )
}
