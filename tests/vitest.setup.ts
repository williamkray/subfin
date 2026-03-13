import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { extractCredentials } from './helpers/db'

const cwd = resolve(process.cwd())
const CONTAINER_NAME = 'subfin-test-ci'
const READY_URL = 'http://localhost:4040/rest/ping?u=x&p=x&c=test&v=1.16.1&f=json'
const TIMEOUT_MS = 120_000

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 401) return
    } catch {
      // network not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`Subfin container did not become ready within ${timeoutMs}ms`)
}

export async function setup() {
  // Clean up any leftover container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' })
  } catch {
    // ignore if not running
  }

  // Build fresh image
  execSync('docker build -t subfin-test .', { stdio: 'inherit' })

  // Start container mounting local data/
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -p 4040:4040 \
      -v ${cwd}/data:/data \
      -e SUBFIN_CONFIG=/data/subfin.config.json \
      -e SUBFIN_LOG_REST=false \
      subfin-test`,
    { stdio: 'inherit' }
  )

  // Wait for the server to be ready
  await waitForReady(READY_URL, TIMEOUT_MS)

  // Extract credentials and inject into process.env for all test files
  const creds = extractCredentials()
  process.env.TEST_SUBSONIC_USERNAME = creds.username
  process.env.TEST_SUBSONIC_PASSWORD = creds.password
  process.env.TEST_JELLYFIN_URL = creds.jellyfinBaseUrl
  process.env.TEST_JELLYFIN_TOKEN = creds.jellyfinToken
  process.env.TEST_JELLYFIN_USER_ID = creds.jellyfinUserId
}

export async function teardown() {
  try {
    execSync(`docker stop ${CONTAINER_NAME} && docker rm ${CONTAINER_NAME}`, { stdio: 'pipe' })
  } catch {
    // ignore errors on teardown
  }
}
