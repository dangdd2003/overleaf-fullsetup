import { createContext, ReactNode, useContext } from 'react'
import OLCard from '@/shared/components/ol/ol-card'

type SectionCardProps = {
  title: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}

// Inside a page that is already one card (the dashboard), sections are
// bordered blocks instead of cards, so cards are never nested.
export const NestedSectionContext = createContext(false)

// The native admin card (as in admin user management): title row, then the body
export default function SectionCard({
  title,
  actions,
  className,
  children,
}: SectionCardProps) {
  const nested = useContext(NestedSectionContext)

  if (nested) {
    return (
      <section className={`border rounded h-100 p-3 ${className ?? ''}`}>
        <div className="d-flex justify-content-between align-items-center gap-2 flex-wrap mb-3">
          <h2 className="h5 my-0">{title}</h2>
          {actions}
        </div>
        {children}
      </section>
    )
  }

  return (
    <OLCard className={className}>
      <div className="d-flex justify-content-between align-items-center gap-2 flex-wrap mb-3">
        <h2 className="h4 my-0">{title}</h2>
        {actions}
      </div>
      {children}
    </OLCard>
  )
}
