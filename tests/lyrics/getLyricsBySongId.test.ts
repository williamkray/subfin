import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'

describe('getLyricsBySongId', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('returns lyricsList with structuredLyrics array', async () => {
    const res = await apiGet('getLyricsBySongId', { id: songId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const lyricsList = r.lyricsList as Record<string, unknown>
    expect(lyricsList).toBeDefined()
    const structuredLyrics = lyricsList.structuredLyrics ?? []
    expect(Array.isArray(structuredLyrics)).toBe(true)
  })
})
