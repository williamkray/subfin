import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('search3', () => {
  it('returns searchResult3 with artist, album, and song arrays', async () => {
    const res = await apiGet('search3', { query: 'a', artistCount: '3', albumCount: '3', songCount: '3' })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const searchResult3 = r.searchResult3 as Record<string, unknown>
    expect(searchResult3).toBeDefined()
    expect(Array.isArray(searchResult3.artist ?? [])).toBe(true)
    expect(Array.isArray(searchResult3.album ?? [])).toBe(true)
    expect(Array.isArray(searchResult3.song ?? [])).toBe(true)
  })

  it('returned album and song IDs exist as valid Jellyfin items', async () => {
    const uid = getJellyfinUserId()
    const res = await apiGet('search3', { query: 'a', artistCount: '0', albumCount: '3', songCount: '3' })
    const r = getSubsonicResponse(res)
    const searchResult3 = r.searchResult3 as Record<string, unknown>

    const albums = (Array.isArray(searchResult3.album) ? searchResult3.album : []) as Array<Record<string, unknown>>
    const songs = (Array.isArray(searchResult3.song) ? searchResult3.song : []) as Array<Record<string, unknown>>

    const itemsToCheck = [
      ...albums.slice(0, 3).map((a) => a.id as string),
      ...songs.slice(0, 3).map((s) => s.id as string),
    ]

    for (const id of itemsToCheck) {
      const jellyfinId = stripSubsonicPrefix(id)
      const jfItem = await jellyfinGet(`/Users/${uid}/Items/${jellyfinId}`)
      expect(jfItem.Name, `Jellyfin item ${jellyfinId} (from subfin id ${id}) not found`).toBeDefined()
    }
  })
})
