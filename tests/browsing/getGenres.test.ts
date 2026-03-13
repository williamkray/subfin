import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getGenres', () => {
  it('returns genres with songCount and albumCount', async () => {
    const res = await apiGet('getGenres')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const genres = r.genres as Record<string, unknown>
    const genreList = Array.isArray(genres.genre) ? genres.genre : [genres.genre]
    expect(genreList.length).toBeGreaterThan(0)
    for (const g of genreList) {
      const genre = g as Record<string, unknown>
      expect(typeof genre.value).toBe('string')
      expect(typeof genre.songCount).toBe('number')
      expect(typeof genre.albumCount).toBe('number')
    }
  })
})
