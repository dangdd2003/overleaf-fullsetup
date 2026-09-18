import Settings from '@overleaf/settings'

function intFromEnv(name, fallback) {
  const val = process.env[name]
  if (val === undefined || val === '') return fallback
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

// Bounded, tunable lifecycle limits. See the request-lifecycle spec §7.
// 0 disables the corresponding reaper, restoring "runs always finish".
if (Settings.aiAssist === undefined) {
  Settings.aiAssist = {
    enabled: process.env.AI_ASSIST_ENABLED === 'true',
    orphanGraceSeconds: intFromEnv('AI_ASSIST_ORPHAN_GRACE_SECONDS', 300),
    approvalTimeoutSeconds: intFromEnv('AI_ASSIST_APPROVAL_TIMEOUT_SECONDS', 600),
    heartbeatStaleSeconds: intFromEnv('AI_ASSIST_HEARTBEAT_STALE_SECONDS', 1800),
    requestTimeoutSeconds: intFromEnv('AI_ASSIST_REQUEST_TIMEOUT_SECONDS', 180),
    // 0 disables the stream idle timer so reasoning models (DeepSeek R1, o1, Claude 3.7 Thinking)
    // and long-prefill local models are not interrupted while thinking.
    streamIdleSeconds: intFromEnv('AI_ASSIST_STREAM_IDLE_SECONDS', 0),
    // SSE comment lines keep reverse proxies from closing an idle run stream
    // during long compiles, approvals and silent thinking. 0 disables them.
    streamKeepAliveSeconds: intFromEnv('AI_ASSIST_STREAM_KEEPALIVE_SECONDS', 15),
    maxTranscriptBytes: intFromEnv('AI_ASSIST_MAX_TRANSCRIPT_BYTES', 5000000),
    // Chat history JSON files; under the data volume so backups include them.
    chatHistoryDir:
      process.env.AI_ASSIST_CHAT_HISTORY_DIR || '/var/lib/overleaf/data/ai-assist',
  }
}

export default Settings.aiAssist
