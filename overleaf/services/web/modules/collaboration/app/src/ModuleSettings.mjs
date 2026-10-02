import Settings from '@overleaf/settings'
import ProjectEditorHandler from '../../../../app/src/Features/Project/ProjectEditorHandler.mjs'
import { registerCommentEmailTemplate } from './CommentEmailTemplate.mjs'

// One switch for upstream's full collaboration feature set: comments, track
// changes, the Reviewer role, @mentions and comment email notifications.
// Disabled, nothing below runs and the editor behaves as plain upstream CE.
if (Settings.enableCollaboration === undefined) {
  Settings.enableCollaboration =
    process.env.COLLABORATION_ENABLED === 'true' ||
    process.env.OVERLEAF_COLLABORATION_ENABLED === 'true'
}

if (Settings.enableCollaboration) {
  // trackChangesVisible is the frontend gate for the review panel, the
  // Editing/Reviewing mode switcher and the Reviewer role in the share modal.
  ProjectEditorHandler.trackChangesAvailable = true

  // On non-SaaS installs split tests resolve through splitTestOverrides. These
  // two gate the File > Settings > Project notifications tab and @mentions in
  // comments (input and rendering). An explicit admin override wins.
  Settings.splitTestOverrides = {
    'email-notifications': 'enabled',
    'comment-mentions': 'enabled',
    ...Settings.splitTestOverrides,
  }

  registerCommentEmailTemplate()
}

export default Settings.enableCollaboration
