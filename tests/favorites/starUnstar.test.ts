import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('star / unstar', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  afterEach(async () => {
    // Always unstar to restore state
    await apiGet('unstar', { id: songId }).catch(() => {})
  })

  it('star a song then verify via getStarred2', async () => {
    const starRes = await apiGet('star', { id: songId })
    assertSubsonicOk(starRes)

    const starredRes = await apiGet('getStarred2')
    assertSubsonicOk(starredRes)
    const r = getSubsonicResponse(starredRes)
    const starred2 = r.starred2 as Record<string, unknown>
    const songs = Array.isArray(starred2.song) ? starred2.song : starred2.song ? [starred2.song] : []
    const found = songs.some((s) => (s as Record<string, unknown>).id === songId)
    expect(found).toBe(true)
  })

  it('unstar a song after starring', async () => {
    await apiGet('star', { id: songId })
    const unstarRes = await apiGet('unstar', { id: songId })
    assertSubsonicOk(unstarRes)
  })

  it('star sets IsFavorite=true in Jellyfin UserData', async () => {
    const uid = getJellyfinUserId()
    const jellyfinSongId = stripSubsonicPrefix(songId)

    await apiGet('star', { id: songId })
    const userData = await jellyfinGet(`/Users/${uid}/Items/${jellyfinSongId}/UserData`)
    expect(userData.IsFavorite).toBe(true)
  })

  it('unstar sets IsFavorite=false in Jellyfin UserData', async () => {
    const uid = getJellyfinUserId()
    const jellyfinSongId = stripSubsonicPrefix(songId)

    await apiGet('star', { id: songId })
    await apiGet('unstar', { id: songId })
    const userData = await jellyfinGet(`/Users/${uid}/Items/${jellyfinSongId}/UserData`)
    expect(userData.IsFavorite).toBe(false)
  })
})
