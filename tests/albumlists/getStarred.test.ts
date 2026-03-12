import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getStarred', () => {
  it('returns starred with artist, album, and song arrays', async () => {
    const res = await apiGet('getStarred')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const starred = r.starred as Record<string, unknown>
    expect(Array.isArray(starred.artist ?? [])).toBe(true)
    expect(Array.isArray(starred.album ?? [])).toBe(true)
    expect(Array.isArray(starred.song ?? [])).toBe(true)
  })
})
