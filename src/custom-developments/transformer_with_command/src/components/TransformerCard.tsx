import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Stat, StatGrid } from '@/components/ui/stat'
import * as scadaOpcApi from '@/lib/scadaOpcApi'
import {
  formatClock,
  formatValue,
  qualityInfo,
  status,
  viz,
  worstQuality,
  type Tone,
} from '@/lib/viz'
import { TransformerDiagram, type SideState } from './TransformerDiagram'
import { EventsGrid } from './EventsGrid'

/**
 * KAW2 TR1 — 230/69 kV transformer bay: live one-line, derived quantities and
 * on-load tap changer control.
 */

const TAGS = {
  hvMw: 'KAW2TR1-2MTWT',
  hvMvar: 'KAW2TR1-2MTVR',
  hvAmps: 'KAW2TR1-2MAPH--B',
  hvWinding: 'KAW2TR1-2YHPT',
  hvBreaker: 'KAW2TR1-2XCBR5202',
  lvMw: 'KAW2TR1-0MTWT',
  lvMvar: 'KAW2TR1-0MTVR',
  lvAmps: 'KAW2TR1-0MAPH--B',
  lvWinding: 'KAW2TR1-0YHPT',
  lvBreaker: 'KAW2TR1-0XCBR5207',
  oilTemp: 'KAW2TR1--YIMT',
  tap: 'KAW2TR1--YTAP',
  buchholz: 'KAW2TR1--YPBH----Alrm',
} as const

/** Protection and supervision digitals shown as a state list under the tiles. */
const DEVICE_ALARMS = [
  { tag: TAGS.buchholz, label: 'Buchholz 63T' },
  { tag: 'KAW2TR1--PTTR----Alrm', label: 'Winding therm. 49' },
  { tag: 'KAW2TR1--PTTI----Alrm', label: 'Oil therm. 26' },
  { tag: 'KAW2TR1--YDTP', label: 'Tap discordance' },
] as const

const READ_TAGS = [
  ...Object.values(TAGS),
  ...DEVICE_ALARMS.map((alarm) => alarm.tag),
].filter((tag, index, all) => all.indexOf(tag) === index)

const TAP_COMMAND = 'KAW2TR1--YTAP--------K'

/** Raise/lower command values, as defined by the command tag in the demo data. */
const TAP_RAISE = 1
const TAP_LOWER = 0

const POLL_MS = 3000
/** A reading older than this is called out as stale rather than shown as live. */
const STALE_MS = 3 * POLL_MS

/**
 * Nameplate rating, MVA. Taken from the high alarm limit of the demo's
 * calculated apparent-power tag (KAW2TR1-2MTVA--------C). Display only — it
 * scales the loading meter and nothing else.
 */
const RATED_MVA = 75

/** OLTC travel, used for the diagram scale. The demo tap sits mid-range. */
const TAP_MIN = 1
const TAP_MAX = 17

/** Temperature alarm thresholds, °C. */
const OIL_WARN = 75
const OIL_ALARM = 90
const WINDING_WARN = 95
const WINDING_ALARM = 105

type Link = 'connecting' | 'live' | 'stale' | 'down'

type CommandPhase = 'idle' | 'sending' | 'waiting' | 'done' | 'failed'

interface CommandState {
  phase: CommandPhase
  direction: 'raise' | 'lower' | null
  message: string
}

const IDLE_COMMAND: CommandState = {
  phase: 'idle',
  direction: null,
  message: '',
}

type Points = Record<string, scadaOpcApi.DataPoint>

export function TransformerCard() {
  const [points, setPoints] = useState<Points>({})
  const [link, setLink] = useState<Link>('connecting')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [command, setCommand] = useState<CommandState>(IDLE_COMMAND)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const data = await scadaOpcApi.getRealTimeData(READ_TAGS)
    if (!mounted.current) return
    // getRealTimeData swallows transport errors and returns an empty array, and
    // drops individual points that came back with a bad service status.
    const received = data.filter((point): point is scadaOpcApi.DataPoint =>
      Boolean(point?.name)
    )
    if (received.length === 0) {
      setLink('down')
      return
    }
    setPoints((previous) => {
      const next: Points = { ...previous }
      for (const point of received) next[point.name] = point
      return next
    })
    setLastUpdate(new Date())
    setLink('live')
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, POLL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  // Age the link indicator between polls, so a hung server does not keep
  // showing the last good reading as if it were current.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!lastUpdate) return
      if (Date.now() - lastUpdate.getTime() > STALE_MS) {
        setLink((current) => (current === 'live' ? 'stale' : current))
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [lastUpdate])

  const value = (tag: string): number | null => {
    const point = points[tag]
    if (!point || !Number.isFinite(point.value)) return null
    return point.value
  }
  const quality = (tag: string): number | undefined => points[tag]?.quality
  const boolean = (tag: string): boolean | null => {
    const point = points[tag]
    if (!point || !Number.isFinite(point.value)) return null
    return point.value !== 0
  }

  const hv: SideState = {
    mw: value(TAGS.hvMw),
    mvar: value(TAGS.hvMvar),
    amps: value(TAGS.hvAmps),
    breakerClosed: boolean(TAGS.hvBreaker),
    quality: worstQuality([
      quality(TAGS.hvMw),
      quality(TAGS.hvMvar),
      quality(TAGS.hvBreaker),
    ]),
  }
  const lv: SideState = {
    mw: value(TAGS.lvMw),
    mvar: value(TAGS.lvMvar),
    amps: value(TAGS.lvAmps),
    breakerClosed: boolean(TAGS.lvBreaker),
    quality: worstQuality([
      quality(TAGS.lvMw),
      quality(TAGS.lvMvar),
      quality(TAGS.lvBreaker),
    ]),
  }

  const tap = value(TAGS.tap)
  const oilTemp = value(TAGS.oilTemp)
  const hvWinding = value(TAGS.hvWinding)
  const lvWinding = value(TAGS.lvWinding)

  // Derived from the HV side, which is the metered infeed of the bank.
  const mva =
    hv.mw !== null && hv.mvar !== null ? Math.hypot(hv.mw, hv.mvar) : null
  const powerFactor = mva && mva > 0.01 ? Math.abs((hv.mw as number) / mva) : null
  // Sign conventions differ per side in the demo data, so compare magnitudes.
  const losses =
    hv.mw !== null && lv.mw !== null ?
      Math.abs(hv.mw) - Math.abs(lv.mw)
    : null
  const loading = mva !== null ? (mva / RATED_MVA) * 100 : null

  const busy = command.phase === 'sending' || command.phase === 'waiting'

  const sendTap = async (direction: 'raise' | 'lower') => {
    setCommand({
      phase: 'sending',
      direction,
      message: 'Sending command…',
    })
    const result = await scadaOpcApi.issueCommand(
      TAP_COMMAND,
      direction === 'raise' ? TAP_RAISE : TAP_LOWER
    )
    if (!mounted.current) return
    if (!result.ok) {
      setCommand({
        phase: 'failed',
        direction,
        message:
          result.error ?
            `Command not accepted — ${result.error}`
          : 'Command rejected by the server.',
      })
      return
    }
    setCommand({
      phase: 'waiting',
      direction,
      message: 'Waiting for protocol acknowledgement…',
    })

    // Track delivery through the driver, the same way the standard viewers do:
    // poll the command tag with the handle returned by the write.
    const deadline = Date.now() + 15000
    while (mounted.current && Date.now() < deadline) {
      await delay(1000)
      if (!mounted.current) return
      const ack = await scadaOpcApi.getCommandAckStatus(
        TAP_COMMAND,
        result.commandHandle
      )
      if (!mounted.current) return
      if (ack === scadaOpcApi.OpcStatusCodes.Good) {
        setCommand({
          phase: 'done',
          direction,
          message: `Tap ${direction} acknowledged at ${formatClock(new Date())}.`,
        })
        refresh()
        return
      }
      if (ack === scadaOpcApi.OpcStatusCodes.Bad) {
        setCommand({
          phase: 'failed',
          direction,
          message: 'Command not acknowledged by the field device.',
        })
        refresh()
        return
      }
    }
    if (!mounted.current) return
    setCommand({
      phase: 'failed',
      direction,
      message: 'Timed out waiting for acknowledgement.',
    })
    refresh()
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-hairline bg-surface-1">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-wide text-ink-1">
              KAW2 · TR1 — 230/69 kV transformer
            </h2>
            <p className="mt-1 text-xs text-ink-3">
              Bay one-line, derived quantities and on-load tap changer control.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <LinkBadge link={link} lastUpdate={lastUpdate} />
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              aria-label="Refresh now"
              title="Refresh now"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>

        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div>
            <TransformerDiagram
              className="h-auto w-full"
              hv={hv}
              lv={lv}
              oilTempC={oilTemp}
              buchholzAlarm={boolean(TAGS.buchholz)}
              tap={tap}
              tapMin={TAP_MIN}
              tapMax={TAP_MAX}
              tapMoving={busy ? (command.direction ?? 'raise') : null}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
              Filled breaker square = closed, hollow = open. Moving dashes show
              the direction of active power flow. Conductors go grey when the
              branch is de-energised or the data behind it is not good.
            </p>
          </div>

          <div className="space-y-3">
            <StatGrid>
              <Stat
                label="Apparent"
                value={formatValue(mva)}
                unit="MVA"
                quality={hv.quality}
              />
              <Stat
                label="Power factor"
                value={powerFactor === null ? '—' : powerFactor.toFixed(3)}
                hint={
                  hv.mvar === null ? undefined
                  : hv.mvar >= 0 ? 'lagging'
                  : 'leading'
                }
                quality={hv.quality}
              />
              <Stat
                label="Losses"
                value={formatValue(losses, 2)}
                unit="MW"
                hint="P(HV) − P(LV)"
                quality={worstQuality([hv.quality, lv.quality])}
              />
              <Stat
                label="Tap"
                value={formatValue(tap)}
                unit="pos"
                quality={quality(TAGS.tap)}
              />
              <Stat
                label="Top oil"
                value={formatValue(oilTemp, 0)}
                unit="°C"
                tone={temperatureTone(oilTemp, OIL_WARN, OIL_ALARM)}
                quality={quality(TAGS.oilTemp)}
              />
              <Stat
                label="HV winding"
                value={formatValue(hvWinding, 0)}
                unit="°C"
                tone={temperatureTone(hvWinding, WINDING_WARN, WINDING_ALARM)}
                quality={quality(TAGS.hvWinding)}
              />
              <Stat
                label="LV winding"
                value={formatValue(lvWinding, 0)}
                unit="°C"
                tone={temperatureTone(lvWinding, WINDING_WARN, WINDING_ALARM)}
                quality={quality(TAGS.lvWinding)}
              />
              <Stat
                label="Loading"
                value={formatValue(loading, 0)}
                unit="%"
                hint={`of ${RATED_MVA} MVA`}
                tone={temperatureTone(loading, 90, 100)}
                quality={hv.quality}
              />
            </StatGrid>

            <LoadingMeter percent={loading} />

            <div className="rounded-md border border-hairline bg-surface-2 p-3">
              <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">
                Device alarms
              </div>
              <ul className="mt-2 space-y-1">
                {DEVICE_ALARMS.map(({ tag, label }) => {
                  const point = points[tag]
                  const alarmed = boolean(tag)
                  return (
                    <li
                      key={tag}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="flex items-center gap-2 text-ink-3">
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              alarmed === null ? viz.ink3
                              : alarmed ? status.critical
                              : status.good,
                          }}
                          aria-hidden
                        />
                        {label}
                      </span>
                      <span
                        className={
                          alarmed ? 'font-medium text-status-critical' : (
                            'text-ink-2'
                          )
                        }
                      >
                        {point?.valueString ??
                          (alarmed === null ? 'no data'
                          : alarmed ? 'ALARMED'
                          : 'NORMAL')}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="rounded-md border border-hairline bg-surface-2 p-3">
              <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">
                Tap changer control
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => sendTap('lower')}
                  disabled={busy}
                  className="border-hairline bg-surface-1 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
                >
                  {busy && command.direction === 'lower' ?
                    <Loader2 className="h-4 w-4 animate-spin" />
                  : <ArrowDown className="h-4 w-4" />}
                  Lower
                </Button>
                <Button
                  variant="outline"
                  onClick={() => sendTap('raise')}
                  disabled={busy}
                  className="border-hairline bg-surface-1 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
                >
                  {busy && command.direction === 'raise' ?
                    <Loader2 className="h-4 w-4 animate-spin" />
                  : <ArrowUp className="h-4 w-4" />}
                  Raise
                </Button>
              </div>
              <p
                role="status"
                aria-live="polite"
                className={`mt-2 min-h-[2.25rem] text-[11px] leading-snug ${commandTextClass(command.phase)}`}
              >
                {command.phase === 'idle' ?
                  'Writes to KAW2TR1--YTAP--------K and follows the protocol acknowledgement.'
                : command.message}
              </p>
            </div>
          </div>
        </div>
      </section>

      <EventsGrid />
    </div>
  )
}

function temperatureTone(
  value: number | null,
  warn: number,
  alarm: number
): Tone {
  if (value === null) return 'unknown'
  if (value >= alarm) return 'critical'
  if (value >= warn) return 'warning'
  return 'good'
}

function commandTextClass(phase: CommandPhase): string {
  switch (phase) {
    case 'done':
      return 'text-status-good'
    case 'failed':
      return 'text-status-critical'
    case 'sending':
    case 'waiting':
      return 'text-status-warning'
    default:
      return 'text-ink-3'
  }
}

function LoadingMeter({ percent }: { percent: number | null }) {
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  const tone =
    percent === null ? 'bg-ink-3'
    : percent >= 100 ? 'bg-status-critical'
    : percent >= 90 ? 'bg-status-warning'
    : 'bg-series-1'
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
      role="img"
      aria-label={`Loading ${percent === null ? 'unknown' : `${Math.round(percent)} percent`} of rating`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

const LINK_TEXT: Record<Link, string> = {
  connecting: 'Connecting',
  live: 'Live',
  stale: 'Stale',
  down: 'No data',
}

function LinkBadge({
  link,
  lastUpdate,
}: {
  link: Link
  lastUpdate: Date | null
}) {
  const tone =
    link === 'live' ? qualityInfo(0)
    : link === 'down' ? qualityInfo(0x80000000)
    : qualityInfo(0x40000000)
  return (
    <span className="flex items-center gap-2 text-xs text-ink-3">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: tone.color }}
        aria-hidden
      />
      {LINK_TEXT[link]}
      {lastUpdate && (
        <span className="font-mono tabular-nums">
          {formatClock(lastUpdate)}
        </span>
      )}
    </span>
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
