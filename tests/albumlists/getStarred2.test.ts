import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getStarred2', () => {
  it('returns starred2 with artist, album, and song arrays', async () => {
    const res = await apiGet('getStarred2')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const starred2 = r.starred2 as Record<string, unknown>
    expect(Array.isArray(starred2.artist ?? [])).toBe(true)
    expect(Array.isArray(starred2.album ?? [])).toBe(true)
    expect(Array.isArray(starred2.song ?? [])).toBe(true)
  })
})
