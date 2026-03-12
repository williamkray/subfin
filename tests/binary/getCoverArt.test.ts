import { describe, it, expect, beforeAll } from 'vitest'
import { apiBinaryGet } from '../helpers/client'
import { getFixtureAlbumId } from '../helpers/fixtures'

describe('getCoverArt', () => {
  let albumId: string

  beforeAll(async () => {
    albumId = await getFixtureAlbumId()
  })

  it('returns HTTP 200 with an image content-type for an album', async () => {
    const res = await apiBinaryGet('getCoverArt', { id: albumId })
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType.startsWith('image/')).toBe(true)
    // Consume body to avoid resource leaks
    await res.body?.cancel()
  })
})
