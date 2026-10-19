import {
  ConnectorModel,
  ConnectorCredentialModel,
  OAuthStateModel,
} from './connectors/ConnectorModel.mjs'
import { AiAssistUserSettingsModel } from './AiAssistUserSettingsModel.mjs'

/**
 * Removes everything the assistant stored for a user: connectors, their
 * sealed credentials, sign-ins in flight and provider settings. The shared
 * OAuth clients belong to the instance, not to the user, so they stay.
 */
export async function removeUserData(userId) {
  await ConnectorCredentialModel.deleteMany({ user_id: userId }).exec()
  await OAuthStateModel.deleteMany({ user_id: userId }).exec()
  await ConnectorModel.deleteMany({ user_id: userId }).exec()
  await AiAssistUserSettingsModel.deleteMany({ user_id: userId }).exec()
}

export default { removeUserData }
