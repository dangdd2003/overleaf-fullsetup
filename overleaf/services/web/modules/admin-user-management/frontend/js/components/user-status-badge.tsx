import OLBadge from '@/shared/components/ol/ol-badge'

interface UserStatusBadgeProps {
  isAdmin?: boolean
  suspended?: boolean
  holdingAccount?: boolean
}

export default function UserStatusBadge({
  isAdmin,
  suspended,
  holdingAccount,
}: UserStatusBadgeProps) {
  if (suspended) {
    return <OLBadge bg="danger">Suspended</OLBadge>
  }
  if (holdingAccount) {
    return <OLBadge bg="warning">Holding</OLBadge>
  }
  if (isAdmin) {
    return <OLBadge bg="primary">Admin</OLBadge>
  }
  return (
    <OLBadge bg="light" text="dark" className="border">
      User
    </OLBadge>
  )
}
