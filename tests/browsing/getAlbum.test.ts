import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'
import { getFixtureAlbumId } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('getAlbum', () => {
  let albumId: string

  beforeAll(async () => {
    albumId = await getFixtureAlbumId()
  })

  it('returns album with song list', async () => {
    const res = await apiGet('getAlbum', { id: albumId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const album = r.album as Record<string, unknown>
    expect(typeof album.id).toBe('string')
    expect(typeof album.name).toBe('string')
    const songs = Array.isArray(album.song) ? album.song : [album.song]
    expect(songs.length).toBeGreaterThan(0)
    for (const song of songs) {
      assertSongShape(song)
    }
  })

  it('song count matches Jellyfin /Users/{id}/Items?ParentId=', async () => {
    const uid = getJellyfinUserId()
    const jellyfinAlbumId = stripSubsonicPrefix(albumId)

    const [subfin, jfResult] = await Promise.all([
      apiGet('getAlbum', { id: albumId }),
      jellyfinGet(`/Users/${uid}/Items`, {
        ParentId: jellyfinAlbumId,
        IncludeItemTypes: 'Audio',
        Recursive: 'true',
        Limit: '0',
      }),
    ])

    const r = getSubsonicResponse(subfin)
    const album = r.album as Record<string, unknown>
    const songs = Array.isArray(album.song) ? album.song : [album.song]
    const subfinCount = songs.filter(Boolean).length

    expect(subfinCount).toBe(jfResult.TotalRecordCount)
  })
})
