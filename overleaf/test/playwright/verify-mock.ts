import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const playwrightBin = path.resolve(__dirname, 'node_modules/.bin/playwright')

async function runVerification() {
  console.log('=== Step 1: TypeScript Type Checking ===')
  try {
    execSync('../../node_modules/.bin/tsc --project tsconfig.json', {
      cwd: __dirname,
      stdio: 'inherit',
    })
    console.log('TypeScript check: PASSED (0 errors)')
  } catch (err) {
    console.error('TypeScript check: FAILED')
    process.exit(1)
  }

  console.log('\n=== Step 2: Starting Mock Overleaf Instance ===')
  const PORT = 3099
  const serverProc = spawn(
    'node',
    ['--experimental-strip-types', path.resolve(__dirname, 'mock-server.ts')],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PORT: `${PORT}` },
    }
  )

  await new Promise<void>((resolve, reject) => {
    serverProc.stdout?.on('data', data => {
      if (data.toString().includes('listening')) {
        console.log(`Mock server ready on http://127.0.0.1:${PORT}`)
        resolve()
      }
    })
    serverProc.on('error', reject)
  })

  console.log('\n=== Step 3: Executing Playwright E2E Test Suite ===')
  try {
    await new Promise<void>((resolve, reject) => {
      const testProc = spawn(
        playwrightBin,
        [
          'test',
          'overleaf/test/playwright/specs/self-service-secondary-emails.spec.ts',
          '--config',
          'overleaf/test/playwright/playwright.config.ts',
        ],
        {
          cwd: repoRoot,
          stdio: 'inherit',
          env: {
            ...process.env,
            OVERLEAF_URL: `http://127.0.0.1:${PORT}`,
          },
        }
      )

      testProc.on('exit', code => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Playwright exited with code ${code}`))
        }
      })
      testProc.on('error', reject)
    })
    console.log('Playwright test run: PASSED')
  } catch (err) {
    console.error('Playwright test run: FAILED', err)
    serverProc.kill()
    process.exit(1)
  } finally {
    serverProc.kill()
  }

  console.log('\n=== Step 4: Verifying Generated Screenshots ===')
  const screenshotsDir = path.resolve(__dirname, 'screenshots')
  const expectedScreenshots = [
    'secondary-email-added.png',
    'secondary-email-promoted.png',
    'secondary-email-deleted.png',
  ]

  let allExist = true
  for (const file of expectedScreenshots) {
    const fullPath = path.join(screenshotsDir, file)
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath)
      console.log(`- ${file}: EXISTS (${stats.size} bytes)`)
    } else {
      console.error(`- ${file}: MISSING`)
      allExist = false
    }
  }

  if (!allExist) {
    console.error('Verification failed: Some screenshots are missing.')
    process.exit(1)
  }

  console.log('\n=== All Verification Steps Completed Successfully! ===')
}

runVerification().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
