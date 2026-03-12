import { describe, it, expect, beforeAll } from 'vitest'
import { apiBinaryGet } from '../helpers/client'
import { getFixtureSongId } from '../helpers/fixtures'

describe('download', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('returns HTTP 200 with an audio content-type', async () => {
    const res = await apiBinaryGet('download', { id: songId })
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType.startsWith('audio/') || contentType === 'application/octet-stream').toBe(true)
    await res.body?.cancel()
  })
})
