import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk, assertPlaylistShape } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'
import { jellyfinGet, getJellyfinUserId } from '../helpers/jellyfin'

describe('playlists CRUD', () => {
  const created: string[] = []
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  afterAll(async () => {
    for (const id of created) {
      await apiGet('deletePlaylist', { id }).catch(() => {})
    }
  })

  it('getPlaylists returns a list', async () => {
    const res = await apiGet('getPlaylists')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const playlists = r.playlists as Record<string, unknown>
    const list = Array.isArray(playlists.playlist) ? playlists.playlist : playlists.playlist ? [playlists.playlist] : []
    expect(Array.isArray(list)).toBe(true)
  })

  it('createPlaylist → getPlaylist → updatePlaylist → deletePlaylist lifecycle', async () => {
    // Create
    const createRes = await apiGet('createPlaylist', { name: 'subfin-test-playlist', [`songId`]: songId })
    assertSubsonicOk(createRes)
    const createR = getSubsonicResponse(createRes)
    const playlist = createR.playlist as Record<string, unknown>
    assertPlaylistShape(playlist)
    const id = playlist.id as string
    created.push(id)

    // Get
    const getRes = await apiGet('getPlaylist', { id })
    assertSubsonicOk(getRes)
    const getR = getSubsonicResponse(getRes)
    const fetched = getR.playlist as Record<string, unknown>
    expect(fetched.id).toBe(id)
    expect(fetched.name).toBe('subfin-test-playlist')

    // Update
    const updateRes = await apiGet('updatePlaylist', { playlistId: id, name: 'subfin-test-playlist-updated' })
    assertSubsonicOk(updateRes)

    // Delete
    const deleteRes = await apiGet('deletePlaylist', { id })
    assertSubsonicOk(deleteRes)
    // Remove from cleanup list since already deleted
    const idx = created.indexOf(id)
    if (idx !== -1) created.splice(idx, 1)
  })

  it('created playlist exists in Jellyfin with correct song count', async () => {
    const uid = getJellyfinUserId()

    const createRes = await apiGet('createPlaylist', { name: 'subfin-test-xval', [`songId`]: songId })
    assertSubsonicOk(createRes)
    const playlist = (getSubsonicResponse(createRes)).playlist as Record<string, unknown>
    const id = playlist.id as string
    created.push(id)

    // Jellyfin playlist IDs have no prefix in subfin
    const jfItem = await jellyfinGet(`/Users/${uid}/Items/${id}`)
    expect(jfItem.Name, `Jellyfin playlist ${id} not found`).toBeDefined()
    expect(jfItem.ChildCount).toBe(1)
  })
})
