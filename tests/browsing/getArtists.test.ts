import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertArtistShape } from '../helpers/assert'
import { jellyfinGet, getJellyfinUserId } from '../helpers/jellyfin'

describe('getArtists', () => {
  it('returns artists index with ignoredArticles', async () => {
    const res = await apiGet('getArtists')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const artists = r.artists as Record<string, unknown>
    expect(typeof artists.ignoredArticles).toBe('string')
    expect(Array.isArray(artists.index)).toBe(true)
  })

  it('each index entry has a name and artist array', async () => {
    const res = await apiGet('getArtists')
    const r = getSubsonicResponse(res)
    const artists = r.artists as Record<string, unknown>
    const indexes = artists.index as Array<Record<string, unknown>>
    for (const idx of indexes) {
      expect(typeof idx.name).toBe('string')
      const artistList = Array.isArray(idx.artist) ? idx.artist : [idx.artist]
      for (const a of artistList) {
        assertArtistShape(a)
      }
    }
  })

  it('artist count is within 10% of Jellyfin AlbumArtists total', async () => {
    const uid = getJellyfinUserId()
    const [subfin, jfResult] = await Promise.all([
      apiGet('getArtists'),
      jellyfinGet('/Artists/AlbumArtists', { UserId: uid, Limit: '0' }),
    ])

    const r = getSubsonicResponse(subfin)
    const artists = r.artists as Record<string, unknown>
    const indexes = artists.index as Array<Record<string, unknown>>
    const subfinCount = indexes.flatMap((i) =>
      Array.isArray(i.artist) ? i.artist : [i.artist]
    ).length

    const jfTotal = jfResult.TotalRecordCount as number
    expect(subfinCount).toBeGreaterThanOrEqual(jfTotal * 0.9)
  })
})
