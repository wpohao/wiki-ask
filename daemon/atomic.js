import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
