import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'
import { getFixtureGenre } from '../helpers/fixtures'

describe('getSongsByGenre', () => {
  let genre: string

  beforeAll(async () => {
    genre = await getFixtureGenre()
  })

  it('returns songs for a genre', async () => {
    const res = await apiGet('getSongsByGenre', { genre, count: '5' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const songsByGenre = r.songsByGenre as Record<string, unknown>
    const songs = Array.isArray(songsByGenre.song) ? songsByGenre.song : songsByGenre.song ? [songsByGenre.song] : []
    for (const song of songs) {
      assertSongShape(song)
    }
  })
})
