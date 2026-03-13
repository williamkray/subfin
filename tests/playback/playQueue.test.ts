import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'

describe('playQueue', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  afterAll(async () => {
    // Clear play queue
    await apiGet('savePlayQueue').catch(() => {})
  })

  it('savePlayQueue and getPlayQueue lifecycle', async () => {
    // Save a play queue with one song
    const saveRes = await apiGet('savePlayQueue', { id: songId, current: songId, position: '0' })
    assertSubsonicOk(saveRes)

    // Get the play queue
    const getRes = await apiGet('getPlayQueue')
    assertSubsonicOk(getRes)
    const r = getSubsonicResponse(getRes)
    const playQueue = r.playQueue as Record<string, unknown>
    expect(playQueue).toBeDefined()
    const entries = Array.isArray(playQueue.entry) ? playQueue.entry : playQueue.entry ? [playQueue.entry] : []
    expect(entries.length).toBeGreaterThan(0)
  })
})
