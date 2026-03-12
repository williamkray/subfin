import { describe, it, expect } from 'vitest'
import { apiBinaryGet } from '../helpers/client'

describe('getAvatar', () => {
  it('returns HTTP 200 or 404 (not 500) for the current user', async () => {
    const username = process.env.TEST_SUBSONIC_USERNAME ?? ''
    const res = await apiBinaryGet('getAvatar', { username })
    expect([200, 404]).toContain(res.status)
    await res.body?.cancel()
  })
})
