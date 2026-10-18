import Settings from '@overleaf/settings'

if (Settings.enableGoogleDriveSync === undefined) {
  Settings.enableGoogleDriveSync = process.env.GOOGLE_DRIVE_ENABLED === 'true'
}

// The OAuth redirect and the channel webhook are derived from the resolved
// site URL, so they always match OVERLEAF_SITE_URL.
const siteUrl = Settings.siteUrl || 'http://localhost'

// A positive whole number from the environment, or the fallback
function intFromEnv(name, fallback) {
  const raw = (process.env[name] || '').trim()
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback
}

Settings.googleDrive = {
  ...Settings.googleDrive,
  clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
  // Generated and persisted by server-ce/init_scripts/100_generate_google_drive_secret.sh
  tokenEncryptionSecret: process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET || '',
  clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
  redirectUri: `${siteUrl}/oauth/google-drive/callback`,
  webhookUrl: siteUrl.startsWith('https://')
    ? `${siteUrl}/google-drive/webhook`
    : '',
  // Operator tuning: the Drive API quota of the Google Cloud project, and how
  // often remote and local changes are synced
  maxRps: intFromEnv('GOOGLE_DRIVE_MAX_RPS', 8),
  pollIntervalSeconds: intFromEnv('GOOGLE_DRIVE_POLL_INTERVAL_SECONDS', 300),
  outboundFlushSeconds: intFromEnv('GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS', 600),
  folderName: 'Overleaf',
  outboundDebounceSeconds: 15,
  channelRenewIntervalSeconds: 3600,
  watchedUserPollRatio: 10,
  manualSyncCooldownSeconds: 60,
}

export default Settings.googleDrive
