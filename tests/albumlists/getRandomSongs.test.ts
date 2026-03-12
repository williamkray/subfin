import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'

describe('getRandomSongs', () => {
  it('returns random songs', async () => {
    const res = await apiGet('getRandomSongs', { size: '5' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const randomSongs = r.randomSongs as Record<string, unknown>
    const songs = Array.isArray(randomSongs.song) ? randomSongs.song : randomSongs.song ? [randomSongs.song] : []
    for (const song of songs) {
      assertSongShape(song)
    }
  })
})
