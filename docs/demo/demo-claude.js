// Demo stand-in for the Claude CLI, used only to record README screenshots/GIFs (see docs/README素材錄製.md).
// Streams like the real CLI with --include-partial-messages: narration, tool calls, then the answer and its stats.
const { join } = require('node:path')
const promptFile = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1] || ''
const pm = /pm\.md$/.test(promptFile)
const emit = v => process.stdout.write(`${JSON.stringify(v)}\n`)
const wait = ms => new Promise(r => setTimeout(r, ms))
let index = 0
async function say(text, { chunk = 4, every = 45 } = {}) {
  const i = index++
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } } })
  for (let at = 0; at < text.length; at += chunk) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: text.slice(at, at + chunk) } } })
    await wait(every)
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: i } })
}
function tool(name, input) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
}
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', async () => {
  const cwd = process.cwd()
  emit({ type: 'system', subtype: 'init', session_id: 'demo' })
  await wait(700)
  await say('先看首頁，找跟點餐有關的文件。', { chunk: 3, every: 60 })
  await wait(300); tool('Read', { file_path: join(cwd, 'index.md') })
  await wait(700); tool('Grep', { pattern: '點餐' })
  await wait(700)
  await say('找到點餐流程和付款規則，兩份都讀。', { chunk: 3, every: 60 })
  await wait(300); tool('Read', { file_path: join(cwd, '點餐', '點餐流程.md') })
  await wait(500); tool('Read', { file_path: join(cwd, '點餐', '付款規則.md') })
  await wait(900)
  const pmAnswer = `點餐是顧客在自助點餐機選餐、付款後拿到取餐號碼，廚房製作完成後叫號取餐的流程。

## 流程

\`\`\`mermaid
flowchart LR
    A["顧客<br/>點餐機選餐"] --> B{"付款方式"}
    B -->|信用卡／行動支付| C["付款成功"]
    B -->|櫃台付現| D["櫃台收款"]
    D --> C
    C --> E["列印取餐號碼<br/>送到廚房"]
    E --> F["廚房製作完成"]
    F --> G["叫號取餐"]
\`\`\`

## 業務規則

1. **付款逾時**：送出後 10 分鐘內未付款，訂單自動取消（見[付款規則](點餐/付款規則.md)）。
2. **櫃台付現**：訂單停在待付款，櫃台收款後才開始製作。
3. **自動完成**：叫號 30 分鐘後未取餐，訂單自動完成。
4. **退款**：需店長在後台授權，退回原付款方式。

<sources>
點餐/點餐流程.md
點餐/付款規則.md
</sources>`
  const rdAnswer = `訂單由 \`POST /api/orders\` 建立，狀態用 \`PATCH /api/orders/{id}/status\` 更新。

| 項目 | 內容 |
|---|---|
| 建立 | \`POST /api/orders\`，必填品項、數量、內用或外帶 |
| 狀態更新 | \`PATCH /api/orders/{id}/status\` |
| 資料表 | \`Order\`、\`OrderItem\` |
| 狀態值 | 待付款 → 製作中 → 待取餐 → 已完成（逾時未付款為已取消） |

付款逾時（10 分鐘）會自動取消訂單，見[付款規則](點餐/付款規則.md)。

<sources>
點餐/點餐流程.md
點餐/付款規則.md
</sources>`
  const answer = pm ? pmAnswer : rdAnswer
  await say(answer, { chunk: 6, every: 35 })
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: pm ? 18_400 : 15_200, num_turns: 4, total_cost_usd: pm ? 0.06 : 0.05, result: answer })
})
