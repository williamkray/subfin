import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getIndexes', () => {
  it('returns indexes with lastModified as a number', async () => {
    const res = await apiGet('getIndexes')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const indexes = r.indexes as Record<string, unknown>
    expect(typeof indexes.lastModified).toBe('number')
    expect(typeof indexes.ignoredArticles).toBe('string')
    expect(Array.isArray(indexes.index)).toBe(true)
  })
})
