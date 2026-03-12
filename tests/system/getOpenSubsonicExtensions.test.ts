import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getOpenSubsonicExtensions', () => {
  it('returns extension list including songLyrics', async () => {
    const res = await apiGet('getOpenSubsonicExtensions')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const extensions = r.openSubsonicExtensions as Array<Record<string, unknown>>
    expect(Array.isArray(extensions)).toBe(true)
    const songLyrics = extensions.find((e) => e.name === 'songLyrics')
    expect(songLyrics).toBeDefined()
    expect(Array.isArray(songLyrics!.versions)).toBe(true)
  })
})
