import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  HamburgerMenuIcon,
  ReloadIcon,
  UpdateIcon,
} from '@radix-ui/react-icons'
import type { FeedStatus } from '../hooks/useRealtimePoints'
import { formatClock } from '../lib/viz'

const FEED_LABEL: Record<FeedStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  live: 'Live',
  stale: 'No data',
  error: 'Disconnected',
}

const FEED_STYLE: Record<FeedStatus, string> = {
  idle: 'text-ink-3',
  connecting: 'text-ink-3',
  live: 'text-status-good',
  stale: 'text-status-warning',
  error: 'text-status-critical',
}

const FEED_ICON: Record<FeedStatus, typeof CheckCircledIcon> = {
  idle: UpdateIcon,
  connecting: UpdateIcon,
  live: CheckCircledIcon,
  stale: ExclamationTriangleIcon,
  error: CrossCircledIcon,
}

interface DashboardHeaderProps {
  status: FeedStatus
  lastUpdate: Date | null
  onRefresh: () => void
  onToggleSidebar: () => void
}

export function DashboardHeader({
  status,
  lastUpdate,
  onRefresh,
  onToggleSidebar,
}: DashboardHeaderProps) {
  const Icon = FEED_ICON[status]

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-hairline bg-surface-1 px-4 py-3 sm:px-6">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle station list"
        className="grid h-8 w-8 place-items-center rounded-md border border-hairline text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-series-1 lg:hidden"
      >
        <HamburgerMenuIcon className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-ink-1">
          Real-time data visualization
        </h1>
        <p className="truncate text-xs text-ink-3">
          {'{json:scada}'} advanced dashboard
        </p>
      </div>

      <div className="flex items-center gap-4">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium ${FEED_STYLE[status]}`}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {FEED_LABEL[status]}
        </span>
        <span
          className="hidden text-xs tabular-nums text-ink-3 sm:inline"
          title="Last successful read"
        >
          {formatClock(lastUpdate)}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-series-1"
        >
          <ReloadIcon className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>
    </header>
  )
}
