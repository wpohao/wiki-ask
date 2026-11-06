import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const caseInsensitive = process.platform === 'win32'

function fold(p) {
  return caseInsensitive ? p.toLowerCase() : p
}

// Returns the path of `target` relative to `root`, or null when target is root itself or outside it.
function insideRelative(root, target) {
  const rel = relative(fold(root), fold(target))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  // relative() on folded strings keeps folded case; slice the original target instead.
  return target.slice(target.length - rel.length)
}

// The real path of a file inside root, or null. With `directory`, a folder instead of a file.
export async function resolveInside(root, relPath, { directory = false } = {}) {
  if (typeof root !== 'string' || typeof relPath !== 'string') return null
  if (!relPath || relPath.includes('\0') || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return null
  try {
    const rootReal = await realpath(root)
    const targetReal = await realpath(resolve(rootReal, relPath))
    if (!insideRelative(rootReal, targetReal)) return null
    const info = await stat(targetReal)
    if (directory ? !info.isDirectory() : !info.isFile()) return null
    return targetReal
  } catch {
    return null
  }
}

export function normalizeWikiPath(p) {
  if (typeof p !== 'string') return null
  let s = p.trim().replace(/^[-*]\s+/, '').trim()
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) s = s.slice(1, -1).trim()
  s = s.replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  if (!s || s.includes('\0') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter(part => part && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

export function relativeToWiki(root, p) {
  if (typeof root !== 'string' || typeof p !== 'string' || !p) return null
  const rel = insideRelative(resolve(root), resolve(root, p))
  return rel ? rel.split(sep).join('/') : null
}

export async function validateWikiDir(dir) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) return null
  try {
    return (await stat(dir)).isDirectory() ? resolve(dir) : null
  } catch {
    return null
  }
}
