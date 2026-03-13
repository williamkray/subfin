import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'
import { getFixtureArtistId, getFixtureArtistName } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('getTopSongs', () => {
  let artistName: string
  let artistId: string

  beforeAll(async () => {
    ;[artistName, artistId] = await Promise.all([getFixtureArtistName(), getFixtureArtistId()])
  })

  it('returns top songs for an artist', async () => {
    const res = await apiGet('getTopSongs', { artist: artistName, count: '5' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const topSongs = r.topSongs as Record<string, unknown>
    const songs = Array.isArray(topSongs.song) ? topSongs.song : topSongs.song ? [topSongs.song] : []
    for (const song of songs) {
      assertSongShape(song)
    }
  })

  it('returned songs belong to the correct artist in Jellyfin', async () => {
    const uid = getJellyfinUserId()
    const jellyfinArtistId = stripSubsonicPrefix(artistId)

    const res = await apiGet('getTopSongs', { artist: artistName, count: '5' })
    const r = getSubsonicResponse(res)
    const topSongs = r.topSongs as Record<string, unknown>
    const songs = (Array.isArray(topSongs.song) ? topSongs.song : topSongs.song ? [topSongs.song] : []) as Array<Record<string, unknown>>

    for (const song of songs.slice(0, 3)) {
      const jellyfinSongId = stripSubsonicPrefix(song.id as string)
      const jfSong = await jellyfinGet(`/Users/${uid}/Items/${jellyfinSongId}`)
      const albumArtistIds = (jfSong.AlbumArtistIds as string[]) ?? []
      const artistItems = ((jfSong.ArtistItems as Array<{ Id: string }>) ?? []).map((a) => a.Id)
      const allArtistIds = [...albumArtistIds, ...artistItems]
      expect(
        allArtistIds.includes(jellyfinArtistId),
        `Song "${jfSong.Name}" does not belong to artist ${jellyfinArtistId}`
      ).toBe(true)
    }
  })
})
