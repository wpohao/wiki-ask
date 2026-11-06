import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isConversationId } from './conversations.js'

export function claudeProjectsDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
}

// Claude stores a session as projects/<encoded cwd>/<id>.jsonl, sometimes with a sibling <id>/ folder.
// The conversation id is the session id (a random UUID), so it is looked up in every project folder
// instead of re-deriving the CLI's folder-name encoding. Only that exact id is removed, never other
// sessions in the same folder (the user may run Claude Code in the WIKI folder too).
export async function removeClaudeSession(projectsDir, id) {
  if (!isConversationId(id)) return 0
  let folders
  try { folders = await readdir(projectsDir, { withFileTypes: true }) } catch { return 0 }
  let removed = 0
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    for (const name of [`${id}.jsonl`, id]) {
      const target = join(projectsDir, folder.name, name)
      try {
        await stat(target)
        await rm(target, { recursive: true, force: true })
        removed += 1
      } catch {}
    }
  }
  return removed
}
