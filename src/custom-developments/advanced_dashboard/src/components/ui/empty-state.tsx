import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  hint?: string
  icon?: ReactNode
}

export function EmptyState({ title, hint, icon }: EmptyStateProps) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-6 text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-3">{hint}</p>}
    </div>
  )
}
