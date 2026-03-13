import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertAlbumShape } from '../helpers/assert'

describe('getAlbumList2', () => {
  it('returns a list of albums for type=newest', async () => {
    const res = await apiGet('getAlbumList2', { type: 'newest', size: '5' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const albumList = r.albumList2 as Record<string, unknown>
    const albums = Array.isArray(albumList.album) ? albumList.album : albumList.album ? [albumList.album] : []
    for (const album of albums) {
      assertAlbumShape(album)
    }
  })

  it('returns a list of albums for type=random', async () => {
    const res = await apiGet('getAlbumList2', { type: 'random', size: '5' })
    assertSubsonicOk(res)
  })
})
