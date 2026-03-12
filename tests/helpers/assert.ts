import { expect } from 'vitest'

export function assertSubsonicOk(res: Record<string, unknown>) {
  const r = res['subsonic-response'] as Record<string, unknown>
  expect(r).toBeDefined()
  expect(r.status).toBe('ok')
  expect(r.openSubsonic).toBe(true)
  expect(r.version).toMatch(/^\d+\.\d+\.\d+$/)
}

export function assertSongShape(song: unknown) {
  const s = song as Record<string, unknown>
  expect(typeof s.id).toBe('string')
  expect(typeof s.title).toBe('string')
  expect(s.isDir).toBe(false)
  expect(s.isVideo).toBeFalsy()
  expect(typeof s.duration).toBe('number')
}

export function assertAlbumShape(album: unknown) {
  const a = album as Record<string, unknown>
  expect(typeof a.id).toBe('string')
  expect(typeof a.name).toBe('string')
}

export function assertArtistShape(artist: unknown) {
  const a = artist as Record<string, unknown>
  expect(typeof a.id).toBe('string')
  expect(typeof a.name).toBe('string')
}

export function assertPlaylistShape(playlist: unknown) {
  const p = playlist as Record<string, unknown>
  expect(typeof p.id).toBe('string')
  expect(typeof p.name).toBe('string')
}
