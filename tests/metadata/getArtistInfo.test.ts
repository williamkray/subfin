import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureArtistId } from '../helpers/fixtures'

describe('getArtistInfo', () => {
  let artistId: string

  beforeAll(async () => {
    artistId = await getFixtureArtistId()
  })

  it('returns artist info with similarArtist array', async () => {
    const res = await apiGet('getArtistInfo', { id: artistId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const artistInfo = r.artistInfo as Record<string, unknown>
    expect(artistInfo).toBeDefined()
    // biography may be empty string, similarArtist is an array (possibly empty)
    expect(Array.isArray(artistInfo.similarArtist ?? [])).toBe(true)
  })
})
