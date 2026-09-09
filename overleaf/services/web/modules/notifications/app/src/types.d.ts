export interface NotificationPreferencesSchema {
  [key: string]: unknown
  commentOnOwnProject?: boolean
  commentOnInvitedProject?: boolean
  repliesOnAuthoredThread?: boolean
  repliesOnParticipatingThread?: boolean
  commentResolvedOnAuthoredThread?: boolean
  commentResolvedOnParticipatingThread?: boolean
  commentReopenedOnAuthoredThread?: boolean
  commentReopenedOnParticipatingThread?: boolean
  trackedChangesOnOwnProject?: boolean
  trackedChangesOnInvitedProject?: boolean
  trackChangesAcceptedOnAuthoredChange?: boolean
  trackChangesRejectedOnAuthoredChange?: boolean
}

export interface GlobalNotificationPreferencesSchema
  extends NotificationPreferencesSchema {
  muteAllNotifications?: boolean
}
