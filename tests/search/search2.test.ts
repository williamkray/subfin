import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('search2', () => {
  it('returns searchResult2 or searchResult3 with results', async () => {
    const res = await apiGet('search2', { query: 'a', artistCount: '3', albumCount: '3', songCount: '3' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    // search2 delegates to search3, returns searchResult3
    const searchResult = r.searchResult3 as Record<string, unknown>
    expect(searchResult).toBeDefined()
    expect(Array.isArray(searchResult.artist ?? [])).toBe(true)
    expect(Array.isArray(searchResult.album ?? [])).toBe(true)
    expect(Array.isArray(searchResult.song ?? [])).toBe(true)
  })
})
