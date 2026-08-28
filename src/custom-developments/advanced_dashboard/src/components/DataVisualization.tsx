import { useCallback, useEffect, useState } from 'react'
import { Cross2Icon, LayersIcon } from '@radix-ui/react-icons'
import { StationList } from './StationList'
import { DashboardHeader } from './DashboardHeader'
import { PointChips } from './PointChips'
import { PointStats } from './PointStats'
import { RealTimeBarGraph } from './RealTimeBarGraph'
import { RealTimeArcGauge } from './RealTimeArcGauge'
import { HistoricalDataPlot } from './HistoricalDataPlot'
import { Panel, PanelHeader } from './ui/panel'
import { Segmented } from './ui/segmented'
import { EmptyState } from './ui/empty-state'
import { useRealtimePoints } from '../hooks/useRealtimePoints'
import { TIME_RANGES, useHistoricalData } from '../hooks/useHistoricalData'

const STORAGE_KEY = 'selectedGraphPoints'
const POLL_INTERVAL_MS = 2000

type View = 'overview' | 'gauges' | 'history'

const VIEWS = [
  { value: 'overview' as const, label: 'Overview' },
  { value: 'gauges' as const, label: 'Gauges' },
  { value: 'history' as const, label: 'History' },
]

function readStoredPoints(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const parsed = stored ? JSON.parse(stored) : []
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

export function DataVisualization() {
  const [selectedPoints, setSelectedPoints] = useState<string[]>(readStoredPoints)
  const [view, setView] = useState<View>('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedPoints))
    } catch {
      // Private-mode storage failures should not take the dashboard down.
    }
  }, [selectedPoints])

  const feed = useRealtimePoints(selectedPoints, POLL_INTERVAL_MS)

  const togglePoint = useCallback((pointName: string) => {
    setSelectedPoints((prev) =>
      prev.includes(pointName) ?
        prev.filter((p) => p !== pointName)
      : [...prev, pointName]
    )
  }, [])

  const removePoint = useCallback((pointName: string) => {
    setSelectedPoints((prev) => prev.filter((p) => p !== pointName))
  }, [])

  const clearPoints = useCallback(() => setSelectedPoints([]), [])

  const hasSelection = selectedPoints.length > 0
  const awaitingFirstRead = hasSelection && feed.points.length === 0

  return (
    <div className="flex h-screen overflow-hidden bg-surface-0">
      {/* Backdrop for the drawer on narrow viewports. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close station list"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 w-72 border-r border-hairline transition-transform lg:static lg:z-auto lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close station list"
          className="absolute right-2 top-2 z-10 grid h-7 w-7 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-1 lg:hidden"
        >
          <Cross2Icon className="h-4 w-4" />
        </button>
        <StationList
          selectedPoints={selectedPoints}
          onTogglePoint={togglePoint}
          liveValues={feed.byName}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          status={feed.status}
          lastUpdate={feed.lastUpdate}
          onRefresh={feed.refresh}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />

        {/* One filter row above everything it scopes. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-hairline bg-surface-1 px-4 py-3 sm:px-6">
          <Segmented
            label="View"
            options={VIEWS}
            value={view}
            onChange={setView}
          />
          <div className="min-w-0 flex-1">
            <PointChips
              points={selectedPoints}
              onRemove={removePoint}
              onClear={clearPoints}
            />
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {!hasSelection ?
            <Panel>
              <EmptyState
                icon={<LayersIcon className="h-6 w-6" />}
                title="No tags selected"
                hint="Pick tags from the station list to plot their live values, gauges and history. The selection is remembered on this browser."
              />
            </Panel>
          : view === 'overview' ?
            <div className="space-y-6">
              {awaitingFirstRead ?
                <LoadingPanel count={selectedPoints.length} />
              : <PointStats
                  points={feed.points}
                  trends={feed.trends}
                  onRemove={removePoint}
                />
              }
              <Panel>
                <PanelHeader
                  title="Current values"
                  description="One reading per selected tag, refreshed every two seconds."
                />
                <div className="p-2 sm:p-4">
                  {awaitingFirstRead ?
                    <div className="h-[340px] animate-pulse rounded bg-surface-2" />
                  : <RealTimeBarGraph points={feed.points} />}
                </div>
              </Panel>
            </div>
          : view === 'gauges' ?
            awaitingFirstRead ?
              <LoadingPanel count={selectedPoints.length} />
            : <RealTimeArcGauge points={feed.points} trends={feed.trends} />

          : <HistoryView points={selectedPoints} />}
        </main>
      </div>
    </div>
  )
}

function LoadingPanel({ count }: { count: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      aria-label="Loading readings"
    >
      {Array.from({ length: Math.min(count, 8) }, (_, index) => (
        <div
          key={index}
          className="h-[136px] animate-pulse rounded-lg border border-hairline bg-surface-1"
        />
      ))}
    </div>
  )
}

/**
 * Owns the historical reads so they only run while the History tab is open.
 */
function HistoryView({ points }: { points: string[] }) {
  const [rangeId, setRangeId] = useState(TIME_RANGES[1].id)
  const [asTable, setAsTable] = useState(false)
  const range = TIME_RANGES.find((r) => r.id === rangeId) ?? TIME_RANGES[1]
  const history = useHistoricalData(points, range)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Time range"
          options={TIME_RANGES.map((r) => ({ value: r.id, label: r.label }))}
          value={rangeId}
          onChange={setRangeId}
        />
        <label className="flex items-center gap-2 text-xs text-ink-3">
          <input
            type="checkbox"
            checked={asTable}
            onChange={(event) => setAsTable(event.target.checked)}
            className="h-3.5 w-3.5 accent-series-1"
          />
          Show values as table
        </label>
      </div>

      {history.error ?
        <Panel>
          <EmptyState
            title="Could not load history"
            hint={history.error.message}
          />
        </Panel>
      : !history.loaded ?
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          {points.slice(0, 4).map((point) => (
            <div
              key={point}
              className="h-[330px] animate-pulse rounded-lg border border-hairline bg-surface-1"
            />
          ))}
        </div>
        // Hold the previous render while a refresh is in flight: no skeleton flash.
      : <div className={history.loading ? 'opacity-60 transition-opacity' : ''}>
          <HistoricalDataPlot series={history.series} asTable={asTable} />
        </div>
      }
    </div>
  )
}
