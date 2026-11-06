import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function generateToken() {
  return randomBytes(32).toString('hex')
}

export function tokenMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function loadOrCreateToken(dir) {
  const file = join(dir, 'token')
  await mkdir(dir, { recursive: true })
  try {
    const existing = await readFile(file, 'utf8')
    const trimmed = existing.trim()
    if (trimmed) {
      // Keep an existing token private as well; mode is not changed by readFile.
      await chmod(file, 0o600).catch(() => {})
      return trimmed
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const token = generateToken()
  try {
    // `wx` prevents a second daemon started at the same time from rotating the
    // token used by the process that won the race and is about to bind the port.
    await writeFile(file, token + '\n', { mode: 0o600, flag: 'wx' })
    return token
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    const existing = (await readFile(file, 'utf8')).trim()
    if (!existing) throw new Error(`token 檔案是空的：${file}`)
    await chmod(file, 0o600).catch(() => {})
    return existing
  }
}
