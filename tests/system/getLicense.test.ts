import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getLicense', () => {
  it('returns a valid license', async () => {
    const res = await apiGet('getLicense')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const license = r.license as Record<string, unknown>
    expect(license.valid).toBe(true)
  })
})
