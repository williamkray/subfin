import { apiGet, getSubsonicResponse } from './client'

let fixtureArtistId: string | null = null
let fixtureArtistName: string | null = null
let fixtureAlbumId: string | null = null
let fixtureSongId: string | null = null
let fixtureGenre: string | null = null

async function loadArtistAndAlbum() {
  if (fixtureArtistId && fixtureAlbumId) return
  const res = await apiGet('getArtists')
  const r = getSubsonicResponse(res)
  const artists = r.artists as Record<string, unknown>
  const indexes = (artists.index as unknown[]) ?? []
  for (const idx of indexes) {
    const index = idx as Record<string, unknown>
    const artistList = Array.isArray(index.artist) ? index.artist : [index.artist]
    for (const a of artistList) {
      const artist = a as Record<string, unknown>
      if (artist.id && artist.name) {
        fixtureArtistId = artist.id as string
        fixtureArtistName = artist.name as string
        break
      }
    }
    if (fixtureArtistId) break
  }
  if (!fixtureArtistId) throw new Error('No artists found in library for fixtures')

  // Load albums for the artist
  const artistRes = await apiGet('getArtist', { id: fixtureArtistId })
  const artistData = getSubsonicResponse(artistRes).artist as Record<string, unknown>
  const albums = Array.isArray(artistData.album) ? artistData.album : [artistData.album]
  const firstAlbum = albums[0] as Record<string, unknown> | undefined
  if (!firstAlbum?.id) throw new Error('No albums found for fixture artist')
  fixtureAlbumId = firstAlbum.id as string
}

async function loadSong() {
  if (fixtureSongId) return
  await loadArtistAndAlbum()
  const albumRes = await apiGet('getAlbum', { id: fixtureAlbumId! })
  const albumData = getSubsonicResponse(albumRes).album as Record<string, unknown>
  const songs = Array.isArray(albumData.song) ? albumData.song : [albumData.song]
  const firstSong = songs[0] as Record<string, unknown> | undefined
  if (!firstSong?.id) throw new Error('No songs found for fixture album')
  fixtureSongId = firstSong.id as string
}

async function loadGenre() {
  if (fixtureGenre) return
  const res = await apiGet('getGenres')
  const r = getSubsonicResponse(res)
  const genres = r.genres as Record<string, unknown>
  const genreList = Array.isArray(genres.genre) ? genres.genre : [genres.genre]
  const first = genreList[0] as Record<string, unknown> | undefined
  if (!first?.value) throw new Error('No genres found in library for fixtures')
  fixtureGenre = first.value as string
}

export async function getFixtureArtistId(): Promise<string> {
  await loadArtistAndAlbum()
  return fixtureArtistId!
}

export async function getFixtureArtistName(): Promise<string> {
  await loadArtistAndAlbum()
  return fixtureArtistName!
}

export async function getFixtureAlbumId(): Promise<string> {
  await loadArtistAndAlbum()
  return fixtureAlbumId!
}

export async function getFixtureSongId(): Promise<string> {
  await loadSong()
  return fixtureSongId!
}

export async function getFixtureGenre(): Promise<string> {
  await loadGenre()
  return fixtureGenre!
}
