import { useCallback, useEffect, useState } from 'react'
import * as scadaOpcApi from '@/lib/scadaOpcApi'
import { formatAgo, qualityInfo, status } from '@/lib/viz'

/** Sequence of events for the TR1 bay, newest first. */

const STATION = 'KAW2'
const EQUIPMENT = 'TR1'
const LOOKBACK_MS = 24 * 60 * 60 * 1000
const LIMIT = 200
const POLL_MS = 10000

/** JSON-SCADA priority: 0 is the most severe. */
const PRIORITY_COLOR = [
  status.critical,
  status.serious,
  status.warning,
  status.good,
]

export function EventsGrid() {
  const [events, setEvents] = useState<scadaOpcApi.SoeData[]>([])
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const fetchEvents = useCallback(async () => {
    const timeBegin = new Date(Date.now() - LOOKBACK_MS)
    const data = await scadaOpcApi.getSoeData(
      [STATION],
      true, // source time
      0, // no aggregation
      LIMIT,
      timeBegin,
      null
    )
    setEvents(data.filter((event) => event?.description?.includes(EQUIPMENT)))
    setLoaded(true)
  }, [])

  useEffect(() => {
    fetchEvents()
    const poll = setInterval(fetchEvents, POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [fetchEvents])

  return (
    <section className="rounded-lg border border-hairline bg-surface-1">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-ink-1">
            Sequence of events
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            {STATION} {EQUIPMENT} · last 24 h · source time
          </p>
        </div>
        <span className="text-xs text-ink-3">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </header>

      <div className="max-h-[320px] overflow-auto">
        {loaded && events.length === 0 ?
          <p className="px-5 py-8 text-center text-xs text-ink-3">
            No events for {EQUIPMENT} in the last 24 hours.
          </p>
        : <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-1">
              <tr className="border-b border-hairline text-left text-[10px] uppercase tracking-[0.08em] text-ink-3">
                <th className="px-5 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-5 py-2 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => {
                const info = qualityInfo(event.quality)
                return (
                  <tr
                    key={event.eventId || index}
                    className="border-b border-hairline last:border-0 hover:bg-surface-2"
                  >
                    <td className="whitespace-nowrap px-5 py-1.5 font-mono tabular-nums text-ink-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              PRIORITY_COLOR[
                                Math.min(
                                  PRIORITY_COLOR.length - 1,
                                  Math.max(0, Math.round(event.priority ?? 3))
                                )
                              ],
                          }}
                          title={`Priority ${event.priority}`}
                        />
                        {event.sourceTimestamp.toLocaleTimeString(undefined, {
                          hour12: false,
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-ink-2">
                      {event.description}
                      {!event.sourceTimestampOk && (
                        <span
                          className="ml-2 text-[10px] text-status-warning"
                          title="Timestamp supplied by the server, not by the field device"
                        >
                          server time
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-medium text-ink-1">
                      {event.valueString}
                      {info.tone !== 'good' && (
                        <span className="ml-2 text-[10px] text-status-warning">
                          {info.label}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-1.5 text-right text-ink-3">
                      {formatAgo(event.sourceTimestamp, now)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        }
      </div>
    </section>
  )
}
