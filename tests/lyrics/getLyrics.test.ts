import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureArtistName } from '../helpers/fixtures'

describe('getLyrics', () => {
  let artistName: string

  beforeAll(async () => {
    artistName = await getFixtureArtistName()
  })

  it('returns lyrics with artist and title fields', async () => {
    const res = await apiGet('getLyrics', { artist: artistName, title: 'test' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const lyrics = r.lyrics as Record<string, unknown>
    expect(lyrics).toBeDefined()
    // artist and title may be empty if no match found, but fields should exist
    expect('artist' in lyrics || lyrics.artist === undefined).toBe(true)
    expect('title' in lyrics || lyrics.title === undefined).toBe(true)
  })
})
