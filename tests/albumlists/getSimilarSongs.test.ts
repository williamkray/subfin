import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'
import { getFixtureArtistId } from '../helpers/fixtures'

describe('getSimilarSongs', () => {
  let artistId: string

  beforeAll(async () => {
    artistId = await getFixtureArtistId()
  })

  it('returns similar songs for an artist id', async () => {
    const res = await apiGet('getSimilarSongs', { id: artistId, count: '5' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const similarSongs = r.similarSongs as Record<string, unknown>
    const songs = Array.isArray(similarSongs.song) ? similarSongs.song : similarSongs.song ? [similarSongs.song] : []
    for (const song of songs) {
      assertSongShape(song)
    }
  })
})
