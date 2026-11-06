const SOURCES_TAG = '<sources>'

// The answer ends with a <sources> block that the daemon strips once the answer is done. While it is still
// streaming, hide that block, and a half-written opening tag at the very end.
export function visibleAnswer(text) {
  const value = String(text || '')
  const at = value.indexOf(SOURCES_TAG)
  if (at !== -1) return value.slice(0, at)
  for (let n = Math.min(SOURCES_TAG.length - 1, value.length); n > 0; n--) {
    if (value.endsWith(SOURCES_TAG.slice(0, n))) return value.slice(0, -n)
  }
  return value
}

// Show the parent folder too: a WIKI has many files with the same name (index.md).
export function shortPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || String(path || '')
}

// "耗時 12 秒 · 6 輪 · 約 US$0.12"; parts that were not reported are left out.
export function statsText(stats) {
  if (!stats || typeof stats !== 'object') return ''
  const parts = []
  if (Number.isFinite(stats.durationMs)) parts.push(`耗時 ${elapsedText(stats.durationMs)}`)
  if (Number.isFinite(stats.turns)) parts.push(`${stats.turns} 輪`)
  if (Number.isFinite(stats.costUsd)) parts.push(stats.costUsd < 0.01 ? '約 < US$0.01' : `約 US$${stats.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}

export function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}
