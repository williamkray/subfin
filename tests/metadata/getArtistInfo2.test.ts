import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureArtistId } from '../helpers/fixtures'

describe('getArtistInfo2', () => {
  let artistId: string

  beforeAll(async () => {
    artistId = await getFixtureArtistId()
  })

  it('returns artistInfo2 with similarArtist array', async () => {
    const res = await apiGet('getArtistInfo2', { id: artistId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const artistInfo2 = r.artistInfo2 as Record<string, unknown>
    expect(artistInfo2).toBeDefined()
    expect(Array.isArray(artistInfo2.similarArtist ?? [])).toBe(true)
  })
})
