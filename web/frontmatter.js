// WIKI documents start with a YAML front matter block; marked would render it as a setext heading.
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontMatter(text) {
  const match = FRONT_MATTER.exec(text)
  if (!match) return { frontMatter: null, body: text }
  return { frontMatter: match[1], body: text.slice(match[0].length) }
}
