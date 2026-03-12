import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureAlbumId } from '../helpers/fixtures'

describe('getAlbumInfo', () => {
  let albumId: string

  beforeAll(async () => {
    albumId = await getFixtureAlbumId()
  })

  it('returns album info', async () => {
    const res = await apiGet('getAlbumInfo', { id: albumId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const albumInfo = r.albumInfo as Record<string, unknown>
    expect(albumInfo).toBeDefined()
  })
})
