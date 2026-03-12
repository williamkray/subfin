import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { jellyfinGet, getJellyfinUserId } from '../helpers/jellyfin'

describe('getMusicFolders', () => {
  it('returns at least one music folder', async () => {
    const res = await apiGet('getMusicFolders')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const musicFolders = r.musicFolders as Record<string, unknown>
    const folders = Array.isArray(musicFolders.musicFolder)
      ? musicFolders.musicFolder
      : [musicFolders.musicFolder]
    expect(folders.length).toBeGreaterThan(0)
    const first = folders[0] as Record<string, unknown>
    expect(first.id).toBeDefined()
    expect(typeof first.name).toBe('string')
  })

  it('folder IDs and names match Jellyfin /Users/{id}/Views', async () => {
    const uid = getJellyfinUserId()
    const [subfin, jfViews] = await Promise.all([
      apiGet('getMusicFolders'),
      jellyfinGet(`/Users/${uid}/Views`),
    ])

    const r = getSubsonicResponse(subfin)
    const musicFolders = r.musicFolders as Record<string, unknown>
    const folders = Array.isArray(musicFolders.musicFolder)
      ? (musicFolders.musicFolder as Array<Record<string, unknown>>)
      : [musicFolders.musicFolder as Record<string, unknown>]

    const jfMusicFolders = (jfViews.Items as Array<Record<string, unknown>>).filter(
      (i) => i.CollectionType === 'music'
    )

    for (const folder of folders) {
      const folderId = folder.id as string
      const match = jfMusicFolders.find((jf) => jf.Id === folderId)
      expect(match, `subfin folder ${folderId} not found in Jellyfin Views`).toBeDefined()
      expect(folder.name).toBe(match!.Name)
    }
  })
})
