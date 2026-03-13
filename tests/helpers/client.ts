const BASE_URL = process.env.TEST_SUBSONIC_URL ?? 'http://localhost:4040'

function authParams(): Record<string, string> {
  return {
    u: process.env.TEST_SUBSONIC_USERNAME ?? '',
    p: process.env.TEST_SUBSONIC_PASSWORD ?? '',
    c: 'subfin-test',
    v: '1.16.1',
    f: 'json',
  }
}

function buildUrl(method: string, params: Record<string, string> = {}): string {
  const all = { ...authParams(), ...params }
  const qs = new URLSearchParams(all).toString()
  return `${BASE_URL}/rest/${method}?${qs}`
}

export async function apiGet(
  method: string,
  params: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const url = buildUrl(method, params)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${method}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

export async function apiBinaryGet(
  method: string,
  params: Record<string, string> = {}
): Promise<Response> {
  const url = buildUrl(method, params)
  return fetch(url)
}

export function getSubsonicResponse(res: Record<string, unknown>) {
  return res['subsonic-response'] as Record<string, unknown>
}
