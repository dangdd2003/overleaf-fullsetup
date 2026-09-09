import Settings from '@overleaf/settings'
import ProjectEditorHandler from '../../../../app/src/Features/Project/ProjectEditorHandler.mjs'

if (Settings.enableCommentNotifications === undefined) {
  Settings.enableCommentNotifications =
    process.env.COMMENT_NOTIFICATIONS_ENABLED === 'true'
}

if (Settings.enableCommentNotifications) {
  ProjectEditorHandler.trackChangesAvailable = true
}

export default Settings.enableCommentNotifications
