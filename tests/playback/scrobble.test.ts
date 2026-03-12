import { describe, it, beforeAll } from 'vitest'
import { apiGet } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'
import { getFixtureSongId } from '../helpers/fixtures'

describe('scrobble', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('scrobbles a song with submission=true', async () => {
    const res = await apiGet('scrobble', { id: songId, submission: 'true' })
    assertSubsonicOk(res)
  })
})
