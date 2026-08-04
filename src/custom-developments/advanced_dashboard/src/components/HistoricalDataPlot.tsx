import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Series } from '../hooks/useHistoricalData'
import { formatTick, formatTimestamp, formatValue, viz } from '../lib/viz'
import { ChartTooltip } from './ui/chart-tooltip'
import { EmptyState } from './ui/empty-state'

interface HistoricalDataPlotProps {
  series: Series[]
  /** Values as a table instead of plots: the WCAG-clean twin of every chart. */
  asTable: boolean
}

export function HistoricalDataPlot({
  series,
  asTable,
}: HistoricalDataPlotProps) {
  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
      {series.map((entry) => (
        <article
          key={entry.pointName}
          className="rounded-lg border border-hairline bg-surface-1"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline px-4 py-3">
            <h3
              className="truncate text-sm font-medium text-ink-1"
              title={entry.pointName}
            >
              {entry.pointName}
            </h3>
            <dl className="flex items-baseline gap-4 text-xs text-ink-3">
              <Summary label="Min" value={entry.samples.length ? entry.min : null} />
              <Summary label="Max" value={entry.samples.length ? entry.max : null} />
              <Summary label="Last" value={entry.last} emphasis />
            </dl>
          </header>

          {entry.samples.length === 0 ?
            <EmptyState
              title="No history in this window"
              hint="Widen the time range, or check that this tag is being historized."
            />
          : asTable ?
            <SampleTable entry={entry} />
          : <div className="h-[260px] p-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={entry.samples}
                  margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid stroke={viz.grid} strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    height={28}
                    minTickGap={56}
                    tickLine={false}
                    axisLine={{ stroke: viz.axis }}
                    tick={{ fill: viz.ink3, fontSize: 11 }}
                    tickFormatter={(value: number) =>
                      new Date(value).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    }
                  />
                  {/*
                    A process value that lives in a narrow band is unreadable
                    against a zero baseline, so the domain follows the data. A
                    line carries no "measured from zero" implication the way a
                    filled area would.
                  */}
                  <YAxis
                    width={56}
                    domain={['auto', 'auto']}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: viz.ink3, fontSize: 11 }}
                    tickFormatter={formatTick}
                  />
                  <Tooltip
                    cursor={{ stroke: viz.axis, strokeWidth: 1 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const sample = payload[0].payload as {
                        time: number
                        value: number
                      }
                      return (
                        <ChartTooltip
                          title={formatTimestamp(new Date(sample.time))}
                          rows={[
                            { label: 'Value', value: formatValue(sample.value) },
                          ]}
                        />
                      )
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={viz.series1}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    activeDot={{
                      r: 4,
                      fill: viz.series1,
                      stroke: viz.surface1,
                      strokeWidth: 2,
                    }}
                    isAnimationActive={false}
                  />
                  {entry.last !== null && (
                    <ReferenceDot
                      x={entry.samples[entry.samples.length - 1].time}
                      y={entry.last}
                      r={4}
                      fill={viz.series1}
                      stroke={viz.surface1}
                      strokeWidth={2}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          }
        </article>
      ))}
    </div>
  )
}

interface SummaryProps {
  label: string
  value: number | null
  emphasis?: boolean
}

function Summary({ label, value, emphasis }: SummaryProps) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt>{label}</dt>
      <dd
        className={`tabular-nums ${emphasis ? 'font-medium text-ink-1' : 'text-ink-2'}`}
      >
        {value === null ? '--' : formatValue(value)}
      </dd>
    </div>
  )
}

function SampleTable({ entry }: { entry: Series }) {
  // Newest first: the current state is what an operator looks for.
  const rows = [...entry.samples].reverse()
  return (
    <div className="max-h-[260px] overflow-y-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">
          Historical samples for {entry.pointName}
        </caption>
        <thead className="sticky top-0 bg-surface-2 text-ink-3">
          <tr>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Timestamp
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Value
            </th>
          </tr>
        </thead>
        <tbody className="text-ink-2">
          {rows.map((sample, index) => (
            <tr
              key={`${sample.time}-${index}`}
              className="border-t border-hairline"
            >
              <td className="px-4 py-1.5 tabular-nums">
                {formatTimestamp(new Date(sample.time))}
              </td>
              <td className="px-4 py-1.5 text-right tabular-nums">
                {formatValue(sample.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
