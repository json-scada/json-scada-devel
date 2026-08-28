import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  ReloadIcon,
} from '@radix-ui/react-icons'
import {
  type DataPoint,
  getGroup1List,
  getRealtimeFilteredData,
} from '../lib/scadaOpcApi'
import { QualityDot } from './ui/status'
import { formatValue } from '../lib/viz'
import { cn } from '../lib/utils'

interface StationData {
  name: string
  points: DataPoint[]
  loading: boolean
  loaded: boolean
  expanded: boolean
}

interface StationListProps {
  selectedPoints: string[]
  /** Selecting an already-selected tag removes it, so the tree is the single control. */
  onTogglePoint: (pointName: string) => void
  /** Live reads for the current selection, so selected rows never show a stale value. */
  liveValues: Record<string, DataPoint | undefined>
}

export function StationList({
  selectedPoints,
  onTogglePoint,
  liveValues,
}: StationListProps) {
  const [stations, setStations] = useState<StationData[]>([])
  const [loadingStations, setLoadingStations] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    const fetchStations = async () => {
      const stationList = await getGroup1List()
      if (cancelled) return
      setStations(
        stationList.map((name) => ({
          name,
          points: [],
          loading: false,
          loaded: false,
          expanded: false,
        }))
      )
      setLoadingStations(false)
    }
    fetchStations()
    return () => {
      cancelled = true
    }
  }, [])

  const loadPoints = useCallback(async (name: string) => {
    setStations((prev) =>
      prev.map((s) => (s.name === name ? { ...s, loading: true } : s))
    )
    try {
      const points = await getRealtimeFilteredData(name, '', false)
      setStations((prev) =>
        prev.map((s) =>
          s.name === name ?
            {
              ...s,
              points: points.filter(Boolean),
              loading: false,
              loaded: true,
            }
          : s
        )
      )
    } catch (error) {
      console.error('Error loading points:', error)
      setStations((prev) =>
        prev.map((s) => (s.name === name ? { ...s, loading: false } : s))
      )
    }
  }, [])

  const toggleStation = useCallback(
    (station: StationData) => {
      setStations((prev) =>
        prev.map((s) =>
          s.name === station.name ? { ...s, expanded: !s.expanded } : s
        )
      )
      if (!station.expanded && !station.loaded && !station.loading) {
        loadPoints(station.name)
      }
    },
    [loadPoints]
  )

  const normalizedQuery = query.trim().toLowerCase()

  const visibleStations = useMemo(() => {
    if (!normalizedQuery) return stations
    return stations.filter(
      (station) =>
        station.name.toLowerCase().includes(normalizedQuery) ||
        station.points.some((point) =>
          point.name.toLowerCase().includes(normalizedQuery)
        )
    )
  }, [stations, normalizedQuery])

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="border-b border-hairline px-4 py-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
          Stations
        </h2>
        <div className="relative">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter stations and tags"
            aria-label="Filter stations and tags"
            className="w-full rounded-md border border-hairline bg-surface-2 py-1.5 pl-8 pr-2 text-xs text-ink-1 placeholder:text-ink-3 focus:border-series-1 focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loadingStations ?
          <ul className="space-y-1.5 px-2 py-1" aria-label="Loading stations">
            {[0, 1, 2, 3, 4].map((index) => (
              <li
                key={index}
                className="h-6 animate-pulse rounded bg-surface-2"
              />
            ))}
          </ul>
        : stations.length === 0 ?
          <p className="px-2 py-4 text-xs text-ink-3">
            No stations available. Check that the SCADA server is reachable.
          </p>
        : visibleStations.length === 0 ?
          <p className="px-2 py-4 text-xs text-ink-3">
            Nothing matches "{query}".
          </p>
        : <ul className="space-y-0.5">
            {visibleStations.map((station) => (
              <li key={station.name}>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => toggleStation(station)}
                    aria-expanded={station.expanded}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-series-1"
                  >
                    {station.expanded ?
                      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    : <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    }
                    <span className="truncate">{station.name}</span>
                    {station.loaded && (
                      <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-ink-3">
                        {station.points.length}
                      </span>
                    )}
                    {station.loading && (
                      <span
                        className="ml-auto h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ink-3 border-t-transparent"
                        aria-hidden
                      />
                    )}
                  </button>
                  {station.expanded && station.loaded && (
                    <button
                      type="button"
                      onClick={() => loadPoints(station.name)}
                      aria-label={`Reload tags of ${station.name}`}
                      title="Reload tags"
                      className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-series-1"
                    >
                      <ReloadIcon className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {station.expanded && (
                  <PointRows
                    station={station}
                    query={normalizedQuery}
                    selectedPoints={selectedPoints}
                    liveValues={liveValues}
                    onTogglePoint={onTogglePoint}
                  />
                )}
              </li>
            ))}
          </ul>
        }
      </div>
    </div>
  )
}

interface PointRowsProps {
  station: StationData
  query: string
  selectedPoints: string[]
  liveValues: Record<string, DataPoint | undefined>
  onTogglePoint: (pointName: string) => void
}

function PointRows({
  station,
  query,
  selectedPoints,
  liveValues,
  onTogglePoint,
}: PointRowsProps) {
  if (station.loading && !station.loaded) {
    return (
      <ul className="ml-4 space-y-1 border-l border-hairline py-1 pl-3">
        {[0, 1, 2].map((index) => (
          <li key={index} className="h-5 animate-pulse rounded bg-surface-2" />
        ))}
      </ul>
    )
  }

  const stationMatches = station.name.toLowerCase().includes(query)
  const points =
    !query || stationMatches ?
      station.points
    : station.points.filter((point) =>
        point.name.toLowerCase().includes(query)
      )

  if (points.length === 0) {
    return (
      <p className="ml-4 border-l border-hairline py-2 pl-3 text-xs text-ink-3">
        No tags in this station.
      </p>
    )
  }

  return (
    <ul className="ml-4 border-l border-hairline pl-1">
      {points.map((point) => {
        const selected = selectedPoints.includes(point.name)
        // A selected tag is being polled, so prefer the live read over the
        // snapshot taken when the station was expanded.
        const current = liveValues[point.name] ?? point
        return (
          <li key={point.name}>
            <button
              type="button"
              onClick={() => onTogglePoint(point.name)}
              aria-pressed={selected}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-series-1',
                selected ?
                  'bg-series-1/15 text-ink-1'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border',
                  selected ?
                    'border-series-1 bg-series-1'
                  : 'border-ink-3/50'
                )}
              >
                {selected && (
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-white">
                    <path
                      d="M1.5 5.2 4 7.5 8.5 2.6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <QualityDot quality={current.quality} />
              <span className="truncate">{point.name}</span>
              <span className="ml-auto shrink-0 pl-2 tabular-nums text-ink-3">
                {current.valueString || formatValue(current.value)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
