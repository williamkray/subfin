import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'

describe('shares CRUD', () => {
  const created: string[] = []
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  afterAll(async () => {
    for (const id of created) {
      await apiGet('deleteShare', { id }).catch(() => {})
    }
  })

  it('createShare → getShares → updateShare → deleteShare lifecycle', async () => {
    // Create
    const createRes = await apiGet('createShare', { id: songId, description: 'subfin-test-share' })
    assertSubsonicOk(createRes)
    const createR = getSubsonicResponse(createRes)
    const shares = createR.shares as Record<string, unknown>
    const shareList = Array.isArray(shares.share) ? shares.share : [shares.share]
    const share = shareList[0] as Record<string, unknown>
    expect(typeof share.id).toBe('string')
    const id = share.id as string
    created.push(id)

    // Get
    const getRes = await apiGet('getShares')
    assertSubsonicOk(getRes)
    const getR = getSubsonicResponse(getRes)
    const getShares = getR.shares as Record<string, unknown>
    const getList = Array.isArray(getShares.share) ? getShares.share : getShares.share ? [getShares.share] : []
    const found = getList.some((s) => (s as Record<string, unknown>).id === id)
    expect(found).toBe(true)

    // Update
    const updateRes = await apiGet('updateShare', { id, description: 'subfin-test-share-updated' })
    assertSubsonicOk(updateRes)

    // Delete
    const deleteRes = await apiGet('deleteShare', { id })
    assertSubsonicOk(deleteRes)
    const idx = created.indexOf(id)
    if (idx !== -1) created.splice(idx, 1)
  })
})
