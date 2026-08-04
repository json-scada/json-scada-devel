import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface PanelProps {
  children: ReactNode
  className?: string
}

/** Card surface used by every dashboard section: hairline ring, no glow. */
export function Panel({ children, className }: PanelProps) {
  return (
    <section
      className={cn(
        'rounded-lg border border-hairline bg-surface-1',
        className
      )}
    >
      {children}
    </section>
  )
}

interface PanelHeaderProps {
  title: string
  description?: string
  children?: ReactNode
}

export function PanelHeader({ title, description, children }: PanelHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-wide text-ink-1">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-xs text-ink-3">{description}</p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  )
}
