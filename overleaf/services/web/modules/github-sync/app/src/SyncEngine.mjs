import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import logger from '@overleaf/logger'

export const GIT_OP_TIMEOUT_MS = 5 * 60 * 1000
export const RESCUE_BRANCH_PREFIX = 'overleaf-sync-'

async function runGit(repoDir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: repoDir,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs || GIT_OP_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message || '').trim()
          logger.warn({ args: args[0], repoDir, stderr: message }, 'git command failed')
          const err = new Error(message || `git ${args[0]} failed`)
          err.stdout = stdout
          err.stderr = stderr
          reject(err)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

async function writeAskpassScript(dir) {
  const targetDir = dir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-askpass-')))
  const scriptPath = path.join(targetDir, 'gh-askpass.sh')
  await fs.writeFile(scriptPath, '#!/bin/sh\nprintf "%s" "$GH_SYNC_TOKEN"\n', {
    mode: 0o700,
  })
  return scriptPath
}

function _authEnv(askpassPath, token) {
  if (!token) return {}
  return {
    GIT_ASKPASS: askpassPath,
    GH_SYNC_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  }
}

async function _withAuth(token, fn) {
  if (!token) return fn({})
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-askpass-'))
  try {
    const scriptPath = await writeAskpassScript(tmpDir)
    const env = _authEnv(scriptPath, token)
    return await fn(env)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function repoDirFor(reposDir, projectId) {
  return path.join(reposDir, String(projectId))
}

async function setConfig(repoDir, key, value) {
  await runGit(repoDir, ['config', key, value])
}

async function cloneRepo(repoDir, httpsUrl, branch, token) {
  await fs.mkdir(repoDir, { recursive: true })
  await _withAuth(token, async env => {
    await runGit(
      path.dirname(repoDir),
      ['clone', '--branch', branch, '--single-branch', httpsUrl, repoDir],
      { env }
    )
  })
  await setConfig(repoDir, 'core.fileMode', 'false')
}

async function createRepo(repoDir, httpsUrl, defaultBranch) {
  await fs.mkdir(repoDir, { recursive: true })
  await runGit(repoDir, ['init', '-b', defaultBranch])
  await runGit(repoDir, ['remote', 'add', 'origin', httpsUrl])
  await setConfig(repoDir, 'core.fileMode', 'false')
}

async function fetchOrigin(repoDir, token) {
  await _withAuth(token, async env => {
    await runGit(repoDir, ['fetch', 'origin'], { env })
  })
}

async function commitAll(repoDir, message, authorName, authorEmail) {
  await runGit(repoDir, ['add', '-A'])
  const { stdout: status } = await runGit(repoDir, ['status', '--porcelain'])
  if (status.trim() === '') return null
  await runGit(repoDir, [
    '-c',
    `user.name=${authorName}`,
    '-c',
    `user.email=${authorEmail}`,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message,
  ])
  const { stdout } = await runGit(repoDir, ['rev-parse', 'HEAD'])
  return stdout.trim()
}

async function mergeOrigin(repoDir, branch) {
  try {
    await runGit(repoDir, [
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-edit',
      `origin/${branch}`,
    ])
    return { merged: true, conflict: false }
  } catch (err) {
    const text = `${String(err.message || '')} ${String(err.stdout || '')} ${String(err.stderr || '')}`
    if (
      text.includes('CONFLICT') ||
      text.includes('Automatic merge failed') ||
      text.includes('fix conflicts')
    ) {
      await runGit(repoDir, ['merge', '--abort']).catch(() => {})
      return { merged: false, conflict: true }
    }
    throw err
  }
}

async function pushRef(repoDir, localRef, remoteRef, token) {
  await _withAuth(token, async env => {
    await runGit(repoDir, ['push', 'origin', `${localRef}:${remoteRef}`], { env })
  })
}

async function pushRescueBranch(repoDir, token) {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-` +
    `${pad(now.getUTCDate())}-${pad(now.getUTCHours())}-` +
    `${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`
  const branchName = `${RESCUE_BRANCH_PREFIX}${stamp}`
  await runGit(repoDir, ['branch', branchName, 'HEAD'])
  await pushRef(repoDir, branchName, branchName, token)
  return branchName
}

async function getHeadSha(repoDir) {
  const { stdout } = await runGit(repoDir, ['rev-parse', 'HEAD'])
  return stdout.trim()
}

async function diffChangeSet(repoDir, fromSha, toRef) {
  // core.quotePath defaults to true, which returns non-ASCII paths as
  // "caf\303\251.tex" (quoted + octal-escaped) and corrupts the entity path.
  const { stdout } = await runGit(repoDir, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-status',
    '-M',
    fromSha,
    toRef,
  ])
  const changes = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [status, ...rest] = line.split('\t')
    if (status.startsWith('R') && rest.length === 2) {
      changes.push({ type: 'R', oldPath: rest[0], path: rest[1] })
    } else if (rest.length === 1) {
      const type = status[0]
      if (['A', 'M', 'D'].includes(type)) changes.push({ type, path: rest[0] })
    }
  }
  return changes
}

async function writeFileFromRepo(repoDir, relPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-blob-'))
  const tmpPath = path.join(tmpDir, path.basename(relPath))
  const content = await fs.readFile(path.join(repoDir, relPath))
  await fs.writeFile(tmpPath, content)
  return { tmpPath, tmpDir }
}

async function deleteRepoDir(repoDir) {
  await fs.rm(repoDir, { recursive: true, force: true })
}

async function ensureRepoExists(repoDir) {
  try {
    await fs.stat(path.join(repoDir, '.git'))
    return true
  } catch {
    return false
  }
}

const SyncEngine = {
  GIT_OP_TIMEOUT_MS,
  RESCUE_BRANCH_PREFIX,
  promises: {
    runGit,
    repoDirFor,
    cloneRepo,
    createRepo,
    fetchOrigin,
    setConfig,
    commitAll,
    mergeOrigin,
    pushRef,
    pushRescueBranch,
    getHeadSha,
    diffChangeSet,
    writeFileFromRepo,
    deleteRepoDir,
    ensureRepoExists,
    writeAskpassScript,
  },
}

export default SyncEngine
