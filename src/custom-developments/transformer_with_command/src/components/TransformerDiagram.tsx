import { viz, status, isGood, formatValue, fraction } from '@/lib/viz'

/**
 * Single-line / elevation drawing of a two-winding power transformer bay.
 *
 * Everything drawn here is driven by live tags: the bay breakers (filled
 * square = closed, hollow = open), the conductor colours (grey when the branch
 * is de-energised or the data behind it is bad), the animated dashes (active
 * power flow, reversed when P is negative), the OLTC scale and the top-oil
 * temperature dial. Nothing is decorative-but-fake — the conservator, tank,
 * radiators and bushings are plain equipment outlines with no value attached.
 */

export interface SideState {
  /** Active power, MW. Positive = flowing into the transformer. */
  mw: number | null
  /** Reactive power, Mvar. */
  mvar: number | null
  /** Line current, A. */
  amps: number | null
  /** Bay breaker: true closed, false open, null unknown. */
  breakerClosed: boolean | null
  /** Worst OPC quality of the side, used to grey out suspect data. */
  quality: number | undefined
}

interface TransformerDiagramProps {
  hv: SideState
  lv: SideState
  /** Top-oil temperature, °C. */
  oilTempC: number | null
  /** Buchholz (63T) gas relay: true alarmed, false normal, null unknown. */
  buchholzAlarm: boolean | null
  /** Tap position. */
  tap: number | null
  tapMin: number
  tapMax: number
  /** Set while a raise/lower command is in flight, to flash the OLTC marker. */
  tapMoving: 'raise' | 'lower' | null
  className?: string
}

const HV_LABEL = '230 kV'
const LV_LABEL = '69 kV'
const HV_BREAKER = '52-02'
const LV_BREAKER = '52-07'

/** Dial span for the top-oil gauge, °C. */
const OIL_DIAL_MIN = 0
const OIL_DIAL_MAX = 120

/** Bright tint used for the moving flow dashes over each conductor colour. */
const FLOW_TINT = {
  [viz.hv]: '#ffd9ac',
  [viz.lv]: '#bcdcff',
} as Record<string, string>

const PHASES = [220, 280, 340]

export function TransformerDiagram({
  hv,
  lv,
  oilTempC,
  buchholzAlarm,
  tap,
  tapMin,
  tapMax,
  tapMoving,
  className,
}: TransformerDiagramProps) {
  const hvLive = hv.breakerClosed === true && isGood(hv.quality)
  const lvLive = lv.breakerClosed === true && isGood(lv.quality)
  const hvColor = hvLive ? viz.hv : viz.deenergized
  const lvColor = lvLive ? viz.lv : viz.deenergized
  const running = hvLive || lvLive

  const hvFlow = hvLive && hv.mw !== null && Math.abs(hv.mw) > 0.05
  const lvFlow = lvLive && lv.mw !== null && Math.abs(lv.mw) > 0.05
  // Both meters are referenced into the transformer, so on the HV side (drawn
  // bus first) positive P runs with the drawing direction, and on the LV side
  // (drawn transformer first) it runs against it.
  const hvReverse = (hv.mw ?? 0) < 0
  const lvReverse = (lv.mw ?? 0) >= 0

  return (
    <svg
      viewBox="0 0 560 470"
      className={className}
      role="img"
      aria-label={`Transformer KAW2 TR1. ${HV_LABEL} side ${describe(hv)}. ${LV_LABEL} side ${describe(lv)}. Tap position ${tap ?? 'unknown'}.`}
    >
      <title>KAW2 TR1 — 230/69 kV transformer bay</title>
      <defs>
        <linearGradient id="tankFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#242b33" />
          <stop offset="55%" stopColor="#1b2026" />
          <stop offset="100%" stopColor="#151a1f" />
        </linearGradient>
        <linearGradient id="oilFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a67c34" />
          <stop offset="100%" stopColor="#6b5223" />
        </linearGradient>
        <marker
          id="tapArrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={status.warning} />
        </marker>
      </defs>

      <style>{`
        .num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
        .lbl { font-family: inherit; }
        @keyframes flowDash { to { stroke-dashoffset: -28; } }
        .flow { stroke-dasharray: 7 21; animation: flowDash 1.1s linear infinite; }
        .flow-rev { animation-direction: reverse; }
        @keyframes fanSpin { to { transform: rotate(360deg); } }
        .fan { animation: fanSpin 3s linear infinite; transform-origin: center; transform-box: fill-box; }
        @keyframes tapPulse { 50% { opacity: 0.25; } }
        .tap-moving { animation: tapPulse 0.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .flow, .fan, .tap-moving { animation: none; }
        }
      `}</style>

      {/* ---------------------------------------------------------- HV bay */}
      <Busbar y={36} color={viz.hv} label={HV_LABEL} labelY={24} />

      <Conductor d="M280 36 V 68" color={hvColor} flow={hvFlow} reverse={hvReverse} />
      <Breaker
        x={280}
        y={80}
        color={hvColor}
        closed={hv.breakerClosed}
        name={HV_BREAKER}
      />
      <Conductor d="M280 92 V 106" color={hvColor} flow={hvFlow} reverse={hvReverse} />

      {/* three-phase header feeding the HV bushings */}
      <path
        d={`M${PHASES[0]} 106 H ${PHASES[2]}`}
        stroke={hvColor}
        strokeWidth={3}
        fill="none"
      />
      {PHASES.map((x) => (
        <path
          key={x}
          d={`M${x} 106 V 122`}
          stroke={hvColor}
          strokeWidth={3}
          fill="none"
        />
      ))}
      {PHASES.map((x) => (
        <Bushing key={x} x={x} yTop={122} yBottom={170} color={hvColor} />
      ))}

      {/* ------------------------------------------------------ tank + aux */}
      <Conservator buchholzAlarm={buchholzAlarm} />
      <Radiators running={running} />

      <rect
        x={150}
        y={170}
        width={260}
        height={150}
        rx={8}
        fill="url(#tankFill)"
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      {/* tank top rim and lifting lugs */}
      <path d="M150 180 H410" stroke={viz.metal} strokeWidth={1} opacity={0.8} />
      <rect x={162} y={166} width={10} height={6} rx={2} fill={viz.metal} />
      <rect x={388} y={166} width={10} height={6} rx={2} fill={viz.metal} />

      {/* nameplate */}
      <rect
        x={158}
        y={294}
        width={58}
        height={16}
        rx={2}
        fill={viz.surface0}
        stroke={viz.metal}
      />
      <text
        x={187}
        y={305}
        className="lbl"
        fontSize={8}
        fill={viz.ink3}
        textAnchor="middle"
        letterSpacing="0.06em"
      >
        KAW2 TR1
      </text>

      <OilGauge cx={372} cy={290} value={oilTempC} />

      {/* winding symbol: HV over LV, with the OLTC arrow across the HV coil */}
      <path
        d={`M${PHASES[0]} 170 V 180 H ${PHASES[2]} V 170`}
        stroke={hvColor}
        strokeWidth={2}
        fill="none"
      />
      <path d="M280 180 V 185" stroke={hvColor} strokeWidth={2} />
      <circle
        cx={280}
        cy={212}
        r={27}
        fill="none"
        stroke={hvColor}
        strokeWidth={2.5}
      />
      <circle
        cx={280}
        cy={260}
        r={27}
        fill="none"
        stroke={lvColor}
        strokeWidth={2.5}
      />
      <path
        d="M250 244 L312 184"
        stroke={status.warning}
        strokeWidth={2}
        markerEnd="url(#tapArrow)"
        className={tapMoving ? 'tap-moving' : undefined}
      />
      <path d="M280 287 V 300" stroke={lvColor} strokeWidth={2} />
      <path
        d={`M${PHASES[0]} 320 V 300 H ${PHASES[2]} V 320`}
        stroke={lvColor}
        strokeWidth={2}
        fill="none"
      />

      <TapChanger
        tap={tap}
        tapMin={tapMin}
        tapMax={tapMax}
        moving={tapMoving !== null}
      />

      {/* ---------------------------------------------------------- LV bay */}
      {PHASES.map((x) => (
        <Bushing key={x} x={x} yTop={320} yBottom={368} color={lvColor} flipped />
      ))}
      {PHASES.map((x) => (
        <path
          key={x}
          d={`M${x} 368 V 386`}
          stroke={lvColor}
          strokeWidth={3}
          fill="none"
        />
      ))}
      <path
        d={`M${PHASES[0]} 386 H ${PHASES[2]}`}
        stroke={lvColor}
        strokeWidth={3}
        fill="none"
      />
      <Conductor d="M280 386 V 392" color={lvColor} flow={lvFlow} reverse={lvReverse} />
      <Breaker
        x={280}
        y={404}
        color={lvColor}
        closed={lv.breakerClosed}
        name={LV_BREAKER}
      />
      <Conductor d="M280 416 V 428" color={lvColor} flow={lvFlow} reverse={lvReverse} />

      <Busbar y={428} color={viz.lv} label={LV_LABEL} labelY={450} />

      {/* -------------------------------------------------------- readouts */}
      <Readout
        x={26}
        y={48}
        title={`${HV_LABEL} side`}
        accent={viz.hv}
        quality={hv.quality}
        rows={[
          { label: 'P', value: formatValue(hv.mw), unit: 'MW' },
          { label: 'Q', value: formatValue(hv.mvar), unit: 'Mvar' },
          { label: 'I', value: formatValue(hv.amps, 0), unit: 'A' },
        ]}
      />
      <Readout
        x={26}
        y={336}
        title={`${LV_LABEL} side`}
        accent={viz.lv}
        quality={lv.quality}
        rows={[
          { label: 'P', value: formatValue(lv.mw), unit: 'MW' },
          { label: 'Q', value: formatValue(lv.mvar), unit: 'Mvar' },
          { label: 'I', value: formatValue(lv.amps, 0), unit: 'A' },
        ]}
      />
    </svg>
  )
}

function describe(side: SideState): string {
  const state =
    side.breakerClosed === null ? 'breaker unknown'
    : side.breakerClosed ? 'breaker closed'
    : 'breaker open'
  return `${state}, ${formatValue(side.mw)} megawatts, ${formatValue(side.mvar)} megavars`
}

/* ------------------------------------------------------------------ parts */

function Busbar({
  y,
  color,
  label,
  labelY,
}: {
  y: number
  color: string
  label: string
  labelY: number
}) {
  return (
    <g>
      <path
        d={`M28 ${y} H532`}
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        opacity={0.9}
      />
      <text
        x={28}
        y={labelY}
        className="lbl"
        fontSize={11}
        fontWeight={600}
        fill={viz.ink2}
        letterSpacing="0.08em"
      >
        {label}
      </text>
    </g>
  )
}

/** Conductor run, with the moving dashes that show active power flow. */
function Conductor({
  d,
  color,
  flow,
  reverse,
}: {
  d: string
  color: string
  flow: boolean
  reverse: boolean
}) {
  return (
    <g>
      <path d={d} stroke={color} strokeWidth={3} fill="none" />
      {flow && (
        <path
          d={d}
          stroke={FLOW_TINT[color] ?? viz.ink2}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
          className={reverse ? 'flow flow-rev' : 'flow'}
        />
      )}
    </g>
  )
}

/** Breaker: filled square closed, hollow open, hatched when the state is lost. */
function Breaker({
  x,
  y,
  color,
  closed,
  name,
}: {
  x: number
  y: number
  color: string
  closed: boolean | null
  name: string
}) {
  const size = 24
  const label =
    closed === null ? 'unknown'
    : closed ? 'closed'
    : 'open'
  const stroke = closed === null ? status.warning : color
  return (
    <g>
      <rect
        x={x - size / 2}
        y={y - size / 2}
        width={size}
        height={size}
        rx={2}
        fill={closed === true ? color : viz.surface0}
        stroke={stroke}
        strokeWidth={2}
      />
      {closed === null && (
        <text
          x={x}
          y={y + 4}
          className="lbl"
          fontSize={12}
          fontWeight={700}
          fill={status.warning}
          textAnchor="middle"
        >
          ?
        </text>
      )}
      <text
        x={x + size / 2 + 8}
        y={y - 1}
        className="lbl"
        fontSize={10}
        fill={viz.ink2}
      >
        {name}
      </text>
      <text
        x={x + size / 2 + 8}
        y={y + 11}
        className="lbl"
        fontSize={9}
        fill={closed === null ? status.warning : viz.ink3}
        letterSpacing="0.06em"
      >
        {label.toUpperCase()}
      </text>
    </g>
  )
}

/**
 * Porcelain bushing: terminal cap, insulator sheds widening towards the tank,
 * and the mounting flange. `flipped` draws it hanging under the tank.
 */
function Bushing({
  x,
  yTop,
  yBottom,
  color,
  flipped = false,
}: {
  x: number
  yTop: number
  yBottom: number
  color: string
  flipped?: boolean
}) {
  const height = yBottom - yTop
  const transform =
    flipped ?
      `translate(${x} ${yBottom}) scale(1 -1)`
    : `translate(${x} ${yTop})`
  return (
    <g transform={transform}>
      {/* conductor running down the core, then the terminal cap over it */}
      <path d={`M0 -2 V ${height}`} stroke={color} strokeWidth={3} />
      <rect x={-7} y={-5} width={14} height={8} rx={2} fill={viz.metalLight} />
      {/* porcelain body, widening towards the tank */}
      <path
        d={`M-4.5 3 L4.5 3 L8 ${height - 9} L-8 ${height - 9} Z`}
        fill="#454f5b"
      />
      {[10, 18, 26, 34].map((y, i) => (
        <ellipse
          key={y}
          cx={0}
          cy={y}
          rx={7 + i * 1.6}
          ry={3.2}
          fill="#5b6673"
          stroke="#333b44"
          strokeWidth={0.7}
        />
      ))}
      <rect
        x={-11}
        y={height - 9}
        width={22}
        height={9}
        rx={2}
        fill={viz.metal}
        stroke={viz.metalLight}
        strokeWidth={0.8}
      />
    </g>
  )
}

/**
 * Oil conservator above the radiator bank, with the pipe into the tank and the
 * Buchholz (gas) relay sitting in that pipe, coloured by its alarm tag.
 */
function Conservator({ buchholzAlarm }: { buchholzAlarm: boolean | null }) {
  const relayTone =
    buchholzAlarm === null ? viz.ink3
    : buchholzAlarm ? status.critical
    : status.good
  return (
    <g>
      <rect
        x={62}
        y={140}
        width={88}
        height={26}
        rx={13}
        fill="url(#oilFill)"
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      <path
        d="M76 141 V165 M136 141 V165"
        stroke={viz.metal}
        strokeWidth={1}
        opacity={0.7}
      />
      <path
        d="M78 166 V196 M134 166 V196"
        stroke={viz.metal}
        strokeWidth={2}
      />
      <path
        d="M150 153 H176 V172"
        stroke={viz.metal}
        strokeWidth={3}
        fill="none"
      />
      <circle
        cx={176}
        cy={158}
        r={6}
        fill={viz.surface0}
        stroke={relayTone}
        strokeWidth={2}
      />
      <text
        x={186}
        y={161}
        className="lbl"
        fontSize={8}
        fill={buchholzAlarm ? status.critical : viz.ink3}
      >
        63T
      </text>
    </g>
  )
}

/** Radiator bank with headers, fins and the two forced-air cooling fans. */
function Radiators({ running }: { running: boolean }) {
  const fins = [80, 90, 100, 110, 120, 130, 140]
  return (
    <g>
      <rect x={70} y={196} width={86} height={8} rx={4} fill={viz.metal} />
      <rect x={70} y={284} width={86} height={8} rx={4} fill={viz.metal} />
      {fins.map((x) => (
        <path
          key={x}
          d={`M${x} 204 V 284`}
          stroke="#39424b"
          strokeWidth={4}
          strokeLinecap="round"
        />
      ))}
      {[95, 129].map((cx) => (
        <g key={cx}>
          <circle
            cx={cx}
            cy={306}
            r={12}
            fill={viz.surface0}
            stroke={viz.metal}
            strokeWidth={1.5}
          />
          <g className={running ? 'fan' : undefined}>
            {[0, 120, 240].map((deg) => (
              <ellipse
                key={deg}
                cx={cx}
                cy={306}
                rx={1.8}
                ry={8}
                fill={viz.metalLight}
                transform={`rotate(${deg} ${cx} 306)`}
              />
            ))}
          </g>
          <circle cx={cx} cy={306} r={2} fill={viz.metal} />
        </g>
      ))}
    </g>
  )
}

/** OLTC compartment: vertical tap scale, position marker and digital window. */
function TapChanger({
  tap,
  tapMin,
  tapMax,
  moving,
}: {
  tap: number | null
  tapMin: number
  tapMax: number
  moving: boolean
}) {
  const scaleTop = 212
  const scaleBottom = 282
  const known = typeof tap === 'number' && Number.isFinite(tap)
  const markerY =
    known ?
      scaleBottom - fraction(tap as number, tapMin, tapMax) * (scaleBottom - scaleTop)
    : (scaleTop + scaleBottom) / 2
  const ticks = 6

  return (
    <g>
      {/* pipes into the tank */}
      <rect x={404} y={200} width={12} height={8} rx={2} fill={viz.metal} />
      <rect x={404} y={262} width={12} height={8} rx={2} fill={viz.metal} />

      <rect
        x={414}
        y={186}
        width={54}
        height={104}
        rx={6}
        fill={viz.surface2}
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      <text
        x={441}
        y={202}
        className="lbl"
        fontSize={9}
        fill={viz.ink3}
        textAnchor="middle"
        letterSpacing="0.1em"
      >
        OLTC
      </text>

      <path
        d={`M432 ${scaleTop} V ${scaleBottom}`}
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const y = scaleTop + (i * (scaleBottom - scaleTop)) / ticks
        return (
          <path
            key={i}
            d={`M426 ${y} H438`}
            stroke={viz.metal}
            strokeWidth={1}
          />
        )
      })}
      <text
        x={422}
        y={scaleTop + 3}
        className="num"
        fontSize={7}
        fill={viz.ink3}
        textAnchor="end"
      >
        {tapMax}
      </text>
      <text
        x={422}
        y={scaleBottom + 3}
        className="num"
        fontSize={7}
        fill={viz.ink3}
        textAnchor="end"
      >
        {tapMin}
      </text>

      {known && (
        <g className={moving ? 'tap-moving' : undefined}>
          <path
            d={`M424 ${markerY} H444`}
            stroke={status.warning}
            strokeWidth={2}
          />
          <path
            d={`M444 ${markerY - 4} L452 ${markerY} L444 ${markerY + 4} z`}
            fill={status.warning}
          />
        </g>
      )}

      {/* digital window under the compartment */}
      <rect
        x={414}
        y={294}
        width={54}
        height={24}
        rx={4}
        fill={viz.surface0}
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      <text
        x={441}
        y={311}
        className="num"
        fontSize={14}
        fontWeight={700}
        fill={status.warning}
        textAnchor="middle"
      >
        {known ? Math.round(tap as number) : '--'}
      </text>
    </g>
  )
}

/** Top-oil temperature dial mounted on the tank wall. */
function OilGauge({
  cx,
  cy,
  value,
}: {
  cx: number
  cy: number
  value: number | null
}) {
  const r = 15
  const known = typeof value === 'number' && Number.isFinite(value)
  const frac = known ? fraction(value as number, OIL_DIAL_MIN, OIL_DIAL_MAX) : 0
  const angle = -120 + 240 * frac
  const tone =
    !known ? viz.ink3
    : (value as number) >= 90 ? status.critical
    : (value as number) >= 75 ? status.warning
    : status.good
  const needle = polar(cx, cy, r - 3, angle)

  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={r + 3}
        fill={viz.surface0}
        stroke={viz.metal}
        strokeWidth={1.5}
      />
      <path
        d={arc(cx, cy, r - 1, -120, 120)}
        stroke={viz.grid}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
      />
      {known && (
        <path
          d={arc(cx, cy, r - 1, -120, angle)}
          stroke={tone}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
      )}
      <path
        d={`M${cx} ${cy} L${needle.x} ${needle.y}`}
        stroke={tone}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={1.8} fill={viz.metalLight} />
      <text
        x={cx}
        y={cy + 15}
        className="num"
        fontSize={8}
        fill={viz.ink2}
        textAnchor="middle"
      >
        {known ? `${Math.round(value as number)}°` : '--'}
      </text>
    </g>
  )
}

interface ReadoutRow {
  label: string
  value: string
  unit: string
}

/** Bay readout block: the P / Q / I the operator reads off the one-line. */
function Readout({
  x,
  y,
  title,
  accent,
  quality,
  rows,
}: {
  x: number
  y: number
  title: string
  accent: string
  quality: number | undefined
  rows: ReadoutRow[]
}) {
  const width = 152
  const height = 82
  const suspect = !isGood(quality)
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        fill={viz.surface2}
        stroke={suspect ? status.warning : viz.grid}
        strokeWidth={1}
      />
      <rect x={x} y={y + 10} width={3} height={height - 20} rx={1.5} fill={accent} />
      <text
        x={x + 14}
        y={y + 19}
        className="lbl"
        fontSize={9.5}
        fill={viz.ink3}
        letterSpacing="0.1em"
      >
        {title.toUpperCase()}
      </text>
      {rows.map((row, i) => {
        const rowY = y + 38 + i * 17
        return (
          <g key={row.label}>
            <text
              x={x + 14}
              y={rowY}
              className="lbl"
              fontSize={11}
              fill={viz.ink3}
            >
              {row.label}
            </text>
            <text
              x={x + width - 34}
              y={rowY}
              className="num"
              fontSize={13}
              fill={suspect ? viz.ink3 : viz.ink1}
              textAnchor="end"
            >
              {row.value}
            </text>
            <text
              x={x + width - 30}
              y={rowY}
              className="lbl"
              fontSize={9}
              fill={viz.ink3}
            >
              {row.unit}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* ---------------------------------------------------------------- geometry */

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const start = polar(cx, cy, r, from)
  const end = polar(cx, cy, r, to)
  const largeArc = Math.abs(to - from) > 180 ? 1 : 0
  return `M${start.x} ${start.y} A${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
}
