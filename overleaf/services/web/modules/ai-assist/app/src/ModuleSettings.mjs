import Settings from '@overleaf/settings'

// The assistant runs entirely in the browser and calls the AI provider directly,
// so the server has nothing to configure beyond whether the feature exists at
// all: no keys, no endpoints, no quotas. `enabled` is read by layout-base.pug to
// set ol-aiAssistEnabled, which is the only signal the frontend needs.
if (Settings.aiAssist === undefined) {
  Settings.aiAssist = {
    enabled: process.env.AI_ASSIST_ENABLED === 'true',
  }
}

export default Settings.aiAssist
