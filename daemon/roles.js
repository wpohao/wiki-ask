import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Role id -> the "## <label>" heading that starts its section in prompts/agent.md.
export const ROLES = { pm: 'PM/PD', rd: 'RD' }
// Conversations created before roles existed have no role and keep the original (RD) answer style.
export const DEFAULT_ROLE = 'rd'

export function isRole(value) {
  return typeof value === 'string' && Object.hasOwn(ROLES, value)
}

export function roleSections(markdown) {
  const byLabel = {}
  let current = null
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = [line]
      byLabel[heading[1]] = current
    } else if (/^#\s/.test(line)) {
      current = null
    } else if (current) {
      current.push(line)
    }
  }
  const sections = {}
  for (const [role, label] of Object.entries(ROLES)) {
    if (!byLabel[label]) throw new Error(`agent.md 缺少「## ${label}」段落`)
    sections[role] = byLabel[label].join('\n').trim()
  }
  return sections
}

// The CLI takes one appended system prompt file, so each role gets the shared rules plus its own section.
export async function writeRolePrompts({ systemFile, agentFile, dir }) {
  const base = (await readFile(systemFile, 'utf8')).trim()
  const sections = roleSections(await readFile(agentFile, 'utf8'))
  await mkdir(dir, { recursive: true })
  const files = {}
  for (const [role, section] of Object.entries(sections)) {
    files[role] = join(dir, `${role}.md`)
    await writeFile(files[role], `${base}\n\n# 使用者身分\n\n以下是這次對話使用者的身分，請依此調整回答的重點與寫法。上面的回答規則（只根據 WIKI 回答、附引用區塊）一律優先。\n\n${section}\n`)
  }
  return files
}
