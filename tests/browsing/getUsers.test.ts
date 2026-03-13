import { describe, it, expect } from 'vitest'
import { apiGet, getSubsonicResponse } from '../helpers/client'
import { assertSubsonicOk } from '../helpers/assert'

describe('getUsers', () => {
  it('returns a list of users', async () => {
    const res = await apiGet('getUsers')
    assertSubsonicOk(res)
    const r = getSubsonicResponse(res)
    const users = r.users as Record<string, unknown>
    const userList = Array.isArray(users.user) ? users.user : [users.user]
    expect(userList.length).toBeGreaterThan(0)
  })
})
