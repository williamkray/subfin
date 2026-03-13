import { describe, it, expect, beforeAll } from 'vitest'
import { apiBinaryGet } from '../helpers/client'
import { getFixtureSongId } from '../helpers/fixtures'

describe('stream', () => {
  let songId: string

  beforeAll(async () => {
    songId = await getFixtureSongId()
  })

  it('returns HTTP 200 or 206 with an audio content-type', async () => {
    const res = await apiBinaryGet('stream', { id: songId })
    expect([200, 206]).toContain(res.status)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType.startsWith('audio/') || contentType === 'application/octet-stream').toBe(true)
    // Do not read body — just cancel to avoid hanging
    await res.body?.cancel()
  })
})
