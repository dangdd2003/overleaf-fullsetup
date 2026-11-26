import {
  ConnectorModel,
  ConnectorCredentialModel,
  OAuthStateModel,
} from './connectors/ConnectorModel.mjs'
import { AiAssistUserSettingsModel } from './AiAssistUserSettingsModel.mjs'
import {
  deleteProjectChats,
  deleteUserChats,
} from './AiAssistChatHistoryStore.mjs'
import {
  deleteProjectCheckpoints,
  deleteUserCheckpoints,
} from './AiAssistCheckpointStore.mjs'
import languageCheckStore from './AiAssistLanguageCheckStore.mjs'
import preferencesStore from './AiAssistPreferencesStore.mjs'

const OBJECT_ID = /^[0-9a-f]{24}$/i

async function stopAndPurgeUserRuns(userId) {
  const { default: runStore } = await import('./AiAssistRunStore.mjs')
  const { default: runManager } = await import('./AiAssistRunManager.mjs')
  const runIds = await runStore.getActiveRunsForUser(userId)
  await Promise.allSettled(
    runIds.map(runId => runManager.stopRun(runId).catch(() => {}))
  )
  await runStore.purgeUserRuns?.(userId, runIds)
}

async function runAllCleanupSteps(steps) {
  const settled = await Promise.allSettled(steps.map(fn => fn()))
  const failures = settled
    .filter(r => r.status === 'rejected')
    .map(r => r.reason)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'ai-assist cleanup failed')
  }
}

/**
 * Removes everything the assistant stored for a user: connectors, their
 * sealed credentials, sign-ins in flight, provider settings, chats,
 * checkpoints, preferences and active/buffered runs. The shared OAuth clients
 * belong to the instance, not to the user, so they stay. Safe to call again.
 */
export async function removeUserData(userId) {
  const uid = String(userId ?? '')
  if (!OBJECT_ID.test(uid)) throw new Error('invalid user id')
  await stopAndPurgeUserRuns(uid).catch(() => {})
  await runAllCleanupSteps([
    () => ConnectorCredentialModel.deleteMany({ user_id: uid }).exec(),
    () => OAuthStateModel.deleteMany({ user_id: uid }).exec(),
    () => ConnectorModel.deleteMany({ user_id: uid }).exec(),
    () => AiAssistUserSettingsModel.deleteMany({ user_id: uid }).exec(),
    () => deleteUserChats(uid),
    () => deleteUserCheckpoints(uid),
    () => preferencesStore.remove(uid),
  ])
}

/**
 * Removes what the assistant stored for a project, of every user: its chats,
 * their checkpoints and the shared language-check results. Safe to call again.
 */
export async function removeProjectData(projectId) {
  const pid = String(projectId ?? '')
  if (!OBJECT_ID.test(pid)) throw new Error('invalid project id')
  await runAllCleanupSteps([
    () => deleteProjectChats(pid),
    () => deleteProjectCheckpoints(pid),
    () => languageCheckStore.remove(pid),
  ])
}

export default { removeUserData, removeProjectData }
