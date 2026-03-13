import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureArtistId } from '../helpers/fixtures'

describe('getMusicDirectory', () => {
  let artistId: string

  beforeAll(async () => {
    artistId = await getFixtureArtistId()
  })

  it('returns a directory for an artist id', async () => {
    const res = await apiGet('getMusicDirectory', { id: artistId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const dir = r.directory as Record<string, unknown>
    expect(typeof dir.id).toBe('string')
    expect(typeof dir.name).toBe('string')
    const children = Array.isArray(dir.child) ? dir.child : dir.child ? [dir.child] : []
    expect(children.length).toBeGreaterThanOrEqual(0)
  })
})
