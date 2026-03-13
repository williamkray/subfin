import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertAlbumShape } from '../helpers/assert'
import { getFixtureArtistId } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('getArtist', () => {
  let artistId: string

  beforeAll(async () => {
    artistId = await getFixtureArtistId()
  })

  it('returns artist with album list', async () => {
    const res = await apiGet('getArtist', { id: artistId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const artist = r.artist as Record<string, unknown>
    expect(typeof artist.id).toBe('string')
    expect(typeof artist.name).toBe('string')
    const albums = Array.isArray(artist.album) ? artist.album : [artist.album]
    expect(albums.length).toBeGreaterThan(0)
    for (const album of albums) {
      assertAlbumShape(album)
    }
  })

  it('album count matches Jellyfin /Users/{id}/Items?ArtistIds=', async () => {
    const uid = getJellyfinUserId()
    const jellyfinArtistId = stripSubsonicPrefix(artistId)

    const [subfin, jfResult] = await Promise.all([
      apiGet('getArtist', { id: artistId }),
      jellyfinGet(`/Users/${uid}/Items`, {
        ArtistIds: jellyfinArtistId,
        IncludeItemTypes: 'MusicAlbum',
        Recursive: 'true',
        Limit: '0',
      }),
    ])

    const r = getSubsonicResponse(subfin)
    const artist = r.artist as Record<string, unknown>
    const albums = Array.isArray(artist.album) ? artist.album : [artist.album]
    const subfinCount = albums.filter(Boolean).length

    expect(subfinCount).toBe(jfResult.TotalRecordCount)
  })
})
