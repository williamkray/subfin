import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getUser', () => {
  it('returns the authenticated user', async () => {
    const res = await apiGet('getUser')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const user = r.user as Record<string, unknown>
    expect(typeof user.username).toBe('string')
    expect(user.username).toBe(process.env.TEST_SUBSONIC_USERNAME)
  })
})
