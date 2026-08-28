import { useCallback, useEffect, useRef, useState } from 'react'
import { getHistoricalData } from '../lib/scadaOpcApi'

export interface TimeRange {
  id: string
  label: string
  minutes: number
  /** Refresh cadence, kept proportional to the window. */
  refreshMs: number
}

export const TIME_RANGES: TimeRange[] = [
  { id: '15m', label: '15 min', minutes: 15, refreshMs: 15_000 },
  { id: '1h', label: '1 hour', minutes: 60, refreshMs: 30_000 },
  { id: '6h', label: '6 hours', minutes: 360, refreshMs: 60_000 },
  { id: '24h', label: '24 hours', minutes: 1440, refreshMs: 300_000 },
]

export interface Sample {
  time: number
  value: number
}

export interface Series {
  pointName: string
  samples: Sample[]
  min: number
  max: number
  last: number | null
}

export interface HistoryFeed {
  series: Series[]
  loading: boolean
  /** True once a read has completed, so the empty state is not shown too early. */
  loaded: boolean
  error: Error | null
  refresh: () => void
}

/**
 * Historical reads for the current selection over a shared time window. Every
 * tag is read in parallel and reduced to a plotting-ready series.
 */
export function useHistoricalData(
  names: string[],
  range: TimeRange
): HistoryFeed {
  const [series, setSeries] = useState<Series[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const key = names.join(' ')
  const namesRef = useRef(names)
  namesRef.current = names

  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const tags = namesRef.current
    if (tags.length === 0) {
      setSeries([])
      setLoaded(false)
      setError(null)
      return
    }

    let cancelled = false

    const read = async () => {
      setLoading(true)
      try {
        const timeBegin = new Date(Date.now() - range.minutes * 60_000)
        const results = await Promise.all(
          tags.map((tag) => getHistoricalData(tag, timeBegin, null))
        )
        if (cancelled) return

        setSeries(
          results.map((rows, index) => {
            const samples = rows
              .filter(Boolean)
              .filter((row) => Number.isFinite(row.value))
              .map((row) => ({
                time: row.serverTimestamp.getTime(),
                value: row.value,
              }))
              .sort((a, b) => a.time - b.time)

            const values = samples.map((sample) => sample.value)
            return {
              pointName: tags[index],
              samples,
              min: values.length ? Math.min(...values) : 0,
              max: values.length ? Math.max(...values) : 0,
              last: values.length ? values[values.length - 1] : null,
            }
          })
        )
        setError(null)
        setLoaded(true)
      } catch (err) {
        if (!cancelled) setError(err as Error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    read()
    const timer = window.setInterval(read, range.refreshMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [key, range.minutes, range.refreshMs, nonce])

  return { series, loading, loaded, error, refresh }
}
