import type { DataPoint } from '../lib/scadaOpcApi'
import { formatValue, niceRange, qualityInfo } from '../lib/viz'
import { ArcGauge } from './ui/arc-gauge'
import { QualityPill } from './ui/status'

interface RealTimeArcGaugeProps {
  points: DataPoint[]
  /** Live window per tag, used to derive an honest scale for each gauge. */
  trends: Record<string, number[]>
}

export function RealTimeArcGauge({ points, trends }: RealTimeArcGaugeProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {points.map((point) => {
        const samples = trends[point.name] ?? []
        const observed = samples.length ? samples : [point.value]
        const [min, max] = niceRange(
          Math.min(...observed),
          Math.max(...observed)
        )
        const suspect = qualityInfo(point.quality).tone !== 'good'

        return (
          <article
            key={point.name}
            className="rounded-lg border border-hairline bg-surface-1 p-4"
          >
            <h3
              className="truncate text-xs font-medium text-ink-3"
              title={point.name}
            >
              {point.name}
            </h3>
            <div className="mt-2">
              <ArcGauge
                value={point.value}
                min={min}
                max={max}
                display={point.valueString || formatValue(point.value)}
                muted={suspect}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <QualityPill quality={point.quality} />
              <span className="text-[11px] text-ink-3">auto scale</span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
