import { describe, it, expect } from 'vitest'
import { apiGet } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('ping', () => {
  it('returns status ok with openSubsonic flag', async () => {
    const res = await apiGet('ping')
    assertSubsonicOk(res)
    const r = res['subsonic-response'] as Record<string, unknown>
    expect(r.openSubsonic).toBe(true)
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('returns error code 40 for bad credentials', async () => {
    const url = 'http://localhost:4040/rest/ping?u=baduser&p=badpass&c=test&v=1.16.1&f=json'
    const res = await fetch(url)
    const json = await res.json() as Record<string, unknown>
    const r = json['subsonic-response'] as Record<string, unknown>
    expect(r.status).toBe('failed')
    const error = r.error as Record<string, unknown>
    expect(error.code).toBe(40)
  })
})
