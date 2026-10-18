import Settings from '@overleaf/settings'

if (Settings.enableGoogleDriveSync === undefined) {
  Settings.enableGoogleDriveSync = process.env.GOOGLE_DRIVE_ENABLED === 'true'
}

if (Settings.googleDrive === undefined) {
  const siteUrl =
    Settings.siteUrl ||
    process.env.OVERLEAF_SITE_URL ||
    'http://localhost'

  const intFromEnv = (key, fallback) => {
    const raw = process.env[key]
    if (raw === undefined || raw === '') return fallback
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  Settings.googleDrive = {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    tokenEncryptionSecret:
      process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET ||
      process.env.GOOGLE_DRIVE_TOKEN_SECRET ||
      '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      `${siteUrl}/oauth/google-drive/callback`,
    webhookUrl:
      process.env.GOOGLE_DRIVE_WEBHOOK_URL !== undefined
        ? process.env.GOOGLE_DRIVE_WEBHOOK_URL
        : siteUrl?.startsWith('https://')
          ? `${siteUrl}/google-drive/webhook`
          : '',
    maxRps: intFromEnv('GOOGLE_DRIVE_MAX_RPS', 8),
    pollIntervalSeconds: intFromEnv('GOOGLE_DRIVE_POLL_INTERVAL_SECONDS', 300),
    outboundFlushSeconds: intFromEnv(
      'GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS',
      600
    ),
    folderName: 'Overleaf',
    outboundDebounceSeconds: 15,
    channelRenewIntervalSeconds: 3600,
    watchedUserPollRatio: 10,
  }
}

export default Settings.googleDrive
