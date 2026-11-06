// How links and images inside WIKI markdown are followed. Paths are WIKI-relative with `/` separators;
// `base` is the folder the markdown lives in ('' = WIKI root, used for Claude's answers).

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

function decode(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

function extension(path) {
  const name = path.split('/').pop()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function dirOf(path) {
  const parts = String(path || '').split('/')
  parts.pop()
  return parts.join('/')
}

// Joins `rel` onto `base`; a leading `/` means the WIKI root. Returns null when the result leaves the WIKI.
export function joinWikiPath(base, rel) {
  const parts = rel.startsWith('/') ? [] : String(base || '').split('/').filter(Boolean)
  for (const part of rel.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

// What clicking a link should do:
//   external → open in a new tab; anchor → scroll within the same document;
//   wiki → open that .md in the preview; folder → open its index.md; text → not followable, show as text.
export function classifyHref(href, base) {
  const raw = String(href || '').trim()
  if (/^https?:\/\//i.test(raw)) return { type: 'external', url: raw }
  if (raw.startsWith('#')) {
    const anchor = decode(raw.slice(1))
    return anchor ? { type: 'anchor', anchor } : { type: 'text' }
  }
  // Other schemes (mailto:, file:, C:\…) and text that merely looks like a link, e.g. `(:56-61)`.
  if (!raw || raw.includes(':')) return { type: 'text' }
  const hashAt = raw.indexOf('#')
  const pathPart = (hashAt === -1 ? raw : raw.slice(0, hashAt)).split('?')[0]
  const anchor = hashAt === -1 ? null : decode(raw.slice(hashAt + 1)) || null
  const decoded = decode(pathPart)
  if (decoded === null || decoded.includes('\0')) return { type: 'text' }
  const path = joinWikiPath(base, decoded)
  if (path === null) return { type: 'text' }
  if (decoded.endsWith('/')) return { type: 'folder', path: path ? `${path}/index.md` : 'index.md' }
  if (extension(path) === '.md') return { type: 'wiki', path, anchor }
  return { type: 'text' }
}

export function classifyImage(src, base) {
  const raw = String(src || '').trim()
  if (/^https?:\/\//i.test(raw)) return { type: 'external', url: raw }
  if (!raw || raw.includes(':')) return { type: 'other' }
  const decoded = decode(raw.split(/[?#]/)[0])
  if (decoded === null) return { type: 'other' }
  const path = joinWikiPath(base, decoded)
  if (!path || !IMAGE_EXTENSIONS.includes(extension(path))) return { type: 'other' }
  return { type: 'wiki', path }
}

// GitHub-style heading anchors, which is how the WIKI writes them: lowercase, punctuation removed,
// spaces become `-`, and repeated headings get -1, -2, ….
export function headingSlug(text) {
  return String(text || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

// Index of the heading the anchor points to, or -1.
export function findHeading(headingTexts, anchor) {
  const wanted = String(anchor || '').trim().toLowerCase()
  if (!wanted) return -1
  const seen = new Map()
  const slugs = headingTexts.map(text => {
    const slug = headingSlug(text)
    const count = seen.get(slug) || 0
    seen.set(slug, count + 1)
    return count ? `${slug}-${count}` : slug
  })
  const exact = slugs.indexOf(wanted)
  if (exact !== -1) return exact
  // Fall back to anchors written by hand (e.g. the heading text itself).
  return slugs.indexOf(headingSlug(anchor))
}

// A link target with spaces, like `.attachments/簡報 (內部用)/a.png`, is not valid markdown, so the whole
// link would show as plain text. Such targets are wrapped in <…>, which markdown accepts. Only targets
// that look like a file or folder path are touched; fenced code blocks are left alone.
export function wrapSpacedTargets(markdown) {
  let fence = null
  return String(markdown || '').split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      return line
    }
    return fence || !line.includes('](') ? line : wrapLine(line)
  }).join('\n')
}

function wrapLine(line) {
  let out = ''
  let from = 0
  for (let start = line.indexOf('](', from); start !== -1; start = line.indexOf('](', from)) {
    const open = start + 2
    let depth = 0
    let end = -1
    for (let i = open; i < line.length; i++) {
      if (line[i] === '(') depth++
      else if (line[i] === ')' && depth-- === 0) { end = i; break }
    }
    if (end === -1) break
    const target = line.slice(open, end)
    out += line.slice(from, open)
    out += needsWrapping(target) ? `<${target.trim()}>` : target
    from = end
  }
  return out + line.slice(from)
}

function needsWrapping(target) {
  const value = target.trim()
  if (!/\s/.test(value) || /[<>]/.test(value) || /^[a-z][\w+.-]*:/i.test(value)) return false
  if (/^\S+\s+("[^"]*"|'[^']*')$/.test(value)) return false // `path "title"` is already valid
  return /\.[A-Za-z0-9]{1,5}$/.test(value) || value.endsWith('/')
}

// Documents converted from Word sometimes keep only a cut-off `data:image/png;base64...` for each picture.
export function isTruncatedDataImage(src) {
  const value = String(src || '').trim()
  return /^data:/i.test(value) && !/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/\s]+=*$/i.test(value)
}

// Where the Word conversion put a document's pictures: <folder>/.attachments/<document name>/.
export function attachmentPath(docPath, name) {
  const folder = dirOf(docPath)
  const stem = docPath.split('/').pop().replace(/\.md$/i, '')
  return [folder, '.attachments', stem, name].filter(Boolean).join('/')
}
