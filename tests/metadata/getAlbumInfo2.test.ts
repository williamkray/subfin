import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureAlbumId } from '../helpers/fixtures'

describe('getAlbumInfo2', () => {
  let albumId: string

  beforeAll(async () => {
    albumId = await getFixtureAlbumId()
  })

  it('returns albumInfo2', async () => {
    const res = await apiGet('getAlbumInfo2', { id: albumId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    // getAlbumInfo2 delegates to getAlbumInfo, both return albumInfo key per spec
    const albumInfo = r.albumInfo as Record<string, unknown>
    expect(albumInfo).toBeDefined()
  })
})
