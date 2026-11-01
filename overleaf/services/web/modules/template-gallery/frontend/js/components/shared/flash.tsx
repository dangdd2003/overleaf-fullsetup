import React from 'react'
import Notification from '@/shared/components/notification'

export type Flash = {
  type: 'success' | 'info' | 'warning' | 'error'
  content: string
}

type FlashNotificationProps = {
  flash: Flash | null
  onDismiss(): void
}

export const FlashNotification = React.memo(function FlashNotification({
  flash,
  onDismiss,
}: FlashNotificationProps) {
  if (!flash) {
    return null
  }
  return (
    <Notification
      type={flash.type}
      content={flash.content}
      ariaLive="polite"
      className="mb-4"
      isDismissible
      onDismiss={onDismiss}
    />
  )
})

export default FlashNotification
