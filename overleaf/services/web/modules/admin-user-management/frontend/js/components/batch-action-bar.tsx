import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import OLButtonGroup from '@/shared/components/ol/ol-button-group'
import OLBadge from '@/shared/components/ol/ol-badge'

export interface BatchActionBarProps {
  selectedCount: number
  tab: 'active' | 'deleted'
  onDeselectAll: () => void
  onRevokeSessions: () => void
  onDelete: () => void
  onRestore: () => void
  onPurge: () => void
}

export default function BatchActionBar({
  selectedCount,
  tab,
  onDeselectAll,
  onRevokeSessions,
  onDelete,
  onRestore,
  onPurge,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null

  const actions =
    tab === 'active' ? (
      <OLButtonGroup size="sm">
        <OLButton
          variant="secondary"
          size="sm"
          leadingIcon="logout"
          onClick={onRevokeSessions}
        >
          Revoke Sessions
        </OLButton>
        <OLButton
          variant="danger"
          size="sm"
          leadingIcon="delete"
          onClick={onDelete}
        >
          Delete Selected
        </OLButton>
      </OLButtonGroup>
    ) : (
      <OLButtonGroup size="sm">
        <OLButton
          variant="primary"
          size="sm"
          leadingIcon="restore_from_trash"
          onClick={onRestore}
        >
          Restore Selected
        </OLButton>
        <OLButton
          variant="danger"
          size="sm"
          leadingIcon="delete_forever"
          onClick={onPurge}
        >
          Purge Selected
        </OLButton>
      </OLButtonGroup>
    )

  return (
    <Notification
      type="info"
      iconPlacement="center"
      className="mb-3 align-items-center"
      content={
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <OLBadge bg="primary">{selectedCount}</OLBadge>
          <span>
            {selectedCount === 1 ? 'user selected' : 'users selected'}
          </span>
          <OLButton
            variant="secondary"
            size="sm"
            onClick={onDeselectAll}
            className="ms-1"
          >
            Deselect all
          </OLButton>
        </div>
      }
      action={actions}
    />
  )
}
