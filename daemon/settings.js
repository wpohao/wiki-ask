import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic.js'
import { validateWikiDir } from './paths.js'

export async function createSettingsStore({ configDir, defaultWikiDir }) {
  const file = join(configDir, 'settings.json')
  let current = { wikiDir: defaultWikiDir }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    // The stored folder may be temporarily unreachable; the server checks it when a question is sent.
    if (typeof parsed?.wikiDir === 'string' && parsed.wikiDir) current = { wikiDir: parsed.wikiDir }
  } catch {}

  let writeChain = Promise.resolve()
  return {
    get() {
      return { ...current }
    },
    async setWikiDir(dir) {
      const wikiDir = await validateWikiDir(dir)
      if (!wikiDir) throw new Error('WIKI 路徑不存在或不是資料夾')
      const next = { wikiDir }
      writeChain = writeChain.catch(() => {}).then(() => writeJsonAtomic(file, next))
      await writeChain
      current = next
      return { ...current }
    },
  }
}
