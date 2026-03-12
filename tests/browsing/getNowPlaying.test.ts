import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getNowPlaying', () => {
  it('returns a nowPlaying with entry array (may be empty)', async () => {
    const res = await apiGet('getNowPlaying')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const nowPlaying = r.nowPlaying as Record<string, unknown>
    const entries = nowPlaying.entry ?? []
    expect(Array.isArray(entries)).toBe(true)
  })
})
