import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic.js'
import { DEFAULT_ROLE } from './roles.js'

const DAY_MS = 86_400_000
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TITLE_LENGTH = 20

export function isConversationId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

function titleFrom(text) {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '))
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH).join('')}…` : chars.join('')
}

function matches(conversation, query) {
  if (!query) return true
  const needle = query.toLowerCase()
  return [conversation.title, ...conversation.messages.map(message => message.text)]
    .some(text => typeof text === 'string' && text.toLowerCase().includes(needle))
}

// onRemove(id) runs after a conversation file is deleted (by remove or purgeExpired); its failures are ignored.
export function createConversationStore({ dir, retentionDays = 14, now = Date.now, onRemove = async () => {} }) {
  const removed = id => Promise.resolve().then(() => onRemove(id)).catch(() => {})
  const chains = new Map()
  const fileOf = id => join(dir, `${id}.json`)
  const expired = conversation => now() - Date.parse(conversation.updatedAt) > retentionDays * DAY_MS

  async function readRaw(id) {
    try {
      const parsed = JSON.parse(await readFile(fileOf(id), 'utf8'))
      if (!parsed || parsed.id !== id || !Array.isArray(parsed.messages)) return null
      parsed.role ??= DEFAULT_ROLE
      return parsed
    } catch {
      return null
    }
  }

  async function read(id) {
    if (!isConversationId(id)) return null
    const conversation = await readRaw(id)
    return conversation && !expired(conversation) ? conversation : null
  }

  // Serialize writes per conversation so concurrent updates (or a delete) never overwrite each other.
  function serialize(id, run) {
    const next = (chains.get(id) || Promise.resolve()).catch(() => {}).then(run)
    chains.set(id, next)
    next.finally(() => { if (chains.get(id) === next) chains.delete(id) }).catch(() => {})
    return next
  }

  function mutate(id, change) {
    return serialize(id, async () => {
      const conversation = await read(id)
      if (!conversation) throw new Error('找不到這個對話')
      change(conversation)
      conversation.updatedAt = new Date(now()).toISOString()
      await writeJsonAtomic(fileOf(id), conversation)
      return conversation
    })
  }

  async function allIds() {
    try {
      return (await readdir(dir)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(isConversationId)
    } catch {
      return []
    }
  }

  return {
    // query matches the title or any question/answer text, case-insensitively.
    async list({ query = '' } = {}) {
      const items = []
      for (const id of await allIds()) {
        const conversation = await read(id)
        if (conversation && matches(conversation, query.trim())) items.push({ id, title: conversation.title, wikiDir: conversation.wikiDir, role: conversation.role, updatedAt: conversation.updatedAt })
      }
      return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    },
    async create({ wikiDir, role = DEFAULT_ROLE }) {
      const at = new Date(now()).toISOString()
      const conversation = { id: randomUUID(), title: '', wikiDir, role, createdAt: at, updatedAt: at, sessionStarted: false, messages: [] }
      await writeJsonAtomic(fileOf(conversation.id), conversation)
      return conversation
    },
    get: read,
    addQuestion(id, text) {
      return mutate(id, conversation => {
        if (!conversation.title) conversation.title = titleFrom(text)
        conversation.messages.push({ role: 'user', text, at: new Date(now()).toISOString() })
      })
    },
    addAnswer(id, { text, sources, tools, error, stats }) {
      return mutate(id, conversation => {
        const message = { role: 'assistant', text, sources, tools, error, at: new Date(now()).toISOString() }
        if (stats) message.stats = stats
        conversation.messages.push(message)
      })
    },
    async markSessionStarted(id) {
      await mutate(id, conversation => { conversation.sessionStarted = true })
    },
    async remove(id) {
      if (!isConversationId(id)) return false
      return serialize(id, async () => {
        if (!(await readRaw(id))) return false
        await rm(fileOf(id), { force: true })
        await removed(id)
        return true
      })
    },
    async purgeExpired() {
      let count = 0
      for (const id of await allIds()) {
        const conversation = await readRaw(id)
        if (conversation && expired(conversation)) {
          await rm(fileOf(id), { force: true })
          await removed(id)
          count += 1
        }
      }
      return count
    },
  }
}
