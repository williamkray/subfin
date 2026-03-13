export async function jellyfinGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const base = process.env.TEST_JELLYFIN_URL ?? ''
  const token = process.env.TEST_JELLYFIN_TOKEN ?? ''
  const qs = new URLSearchParams(params).toString()
  const url = `${base}${path}${qs ? '?' + qs : ''}`
  const res = await fetch(url, { headers: { Authorization: `MediaBrowser Token="${token}"` } })
  return res.json()
}

export function getJellyfinUserId(): string {
  return process.env.TEST_JELLYFIN_USER_ID ?? ''
}

export function stripSubsonicPrefix(id: string): string {
  return id.replace(/^(ar|al|pl)-/, '')
}
