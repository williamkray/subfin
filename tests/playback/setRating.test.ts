import { describe, it, beforeAll } from 'vitest'
import { apiGet } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'

describe('setRating', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('sets a rating of 3 on a song', async () => {
    const res = await apiGet('setRating', { id: songId, rating: '3' })
    assertSubsonicOk(res)
  })

  it('clears a rating (rating=0) on a song', async () => {
    const res = await apiGet('setRating', { id: songId, rating: '0' })
    assertSubsonicOk(res)
  })
})
