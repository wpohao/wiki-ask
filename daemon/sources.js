import { normalizeWikiPath } from './paths.js'

const OPEN = '<sources>'
const CLOSE = '</sources>'

export function extractSources(text) {
  const start = text.lastIndexOf(OPEN)
  const end = start === -1 ? -1 : text.indexOf(CLOSE, start)
  if (end === -1) return { body: text, sources: [] }

  const sources = []
  for (const line of text.slice(start + OPEN.length, end).split(/\r?\n/)) {
    const path = normalizeWikiPath(line)
    if (path && !sources.includes(path)) sources.push(path)
  }
  const body = (text.slice(0, start) + text.slice(end + CLOSE.length)).trim()
  return { body, sources }
}

export function pickSources(declared, readFiles) {
  if (declared.length) return declared
  return [...new Set(readFiles.filter(path => path.toLowerCase().endsWith('.md')))]
}
