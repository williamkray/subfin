import { describe, it, expect, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertSongShape } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId, stripSubsonicPrefix } from '../helpers/jellyfin'

describe('getSong', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('returns a song with isDir=false', async () => {
    const res = await apiGet('getSong', { id: songId })
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const song = r.song as Record<string, unknown>
    assertSongShape(song)
    expect(song.isDir).toBe(false)
  })

  it('title and duration match Jellyfin item', async () => {
    const uid = getJellyfinUserId()
    const jellyfinSongId = stripSubsonicPrefix(songId)

    const [subfin, jfItem] = await Promise.all([
      apiGet('getSong', { id: songId }),
      jellyfinGet(`/Users/${uid}/Items/${jellyfinSongId}`),
    ])

    const r = getSubsonicResponse(subfin)
    const song = r.song as Record<string, unknown>

    expect(song.title).toBe(jfItem.Name)
    const jfDuration = Math.round((jfItem.RunTimeTicks as number) / 10_000_000)
    expect(Math.abs((song.duration as number) - jfDuration)).toBeLessThanOrEqual(1)
  })
})
