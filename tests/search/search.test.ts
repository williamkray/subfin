import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('search (legacy)', () => {
  it('returns searchResult with artists, albums, and songs', async () => {
    const res = await apiGet('search', { query: 'a', artistCount: '3', albumCount: '3', songCount: '3' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    // Legacy search delegates to search3, returns searchResult3
    const searchResult = r.searchResult3 as Record<string, unknown>
    expect(searchResult).toBeDefined()
    expect(Array.isArray(searchResult.artist ?? [])).toBe(true)
    expect(Array.isArray(searchResult.album ?? [])).toBe(true)
    expect(Array.isArray(searchResult.song ?? [])).toBe(true)
  })
})
