import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircledIcon,
} from '@radix-ui/react-icons'
import { qualityInfo, type QualityTone } from '../../lib/viz'
import { cn } from '../../lib/utils'

const ICONS: Record<QualityTone, typeof CheckCircledIcon> = {
  good: CheckCircledIcon,
  warning: ExclamationTriangleIcon,
  critical: CrossCircledIcon,
  unknown: QuestionMarkCircledIcon,
}

const TEXT: Record<QualityTone, string> = {
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  unknown: 'text-ink-3',
}

interface QualityPillProps {
  quality: number | undefined | null
  className?: string
}

/**
 * Quality readout. Status is always icon plus label, never colour alone, so it
 * survives colour-vision deficiency and forced-colours mode.
 */
export function QualityPill({ quality, className }: QualityPillProps) {
  const info = qualityInfo(quality)
  const Icon = ICONS[info.tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        TEXT[info.tone],
        className
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {info.label}
    </span>
  )
}

interface QualityDotProps {
  quality: number | undefined | null
  className?: string
}

/** Dense variant for list rows, where the pill label lives in the title attribute. */
export function QualityDot({ quality, className }: QualityDotProps) {
  const info = qualityInfo(quality)
  return (
    <span
      title={`Quality: ${info.label}`}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: info.color }}
    >
      <span className="sr-only">{info.label}</span>
    </span>
  )
}
