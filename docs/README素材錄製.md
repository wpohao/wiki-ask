# README 截圖與 GIF 錄製方式

README 的截圖與 GIF（`docs/images/`）都用虛構的示範 WIKI 和假 Claude 錄製，不用真的 WIKI、也不會呼叫 Claude CLI。介面有改時照這份重錄。

## 原則

- **不能露出個人資料**：畫面上不能有本機帳號路徑（`C:\Users\<帳號>\…`）、帳號名或中文署名。WIKI 路徑一律顯示成 `C:\Users\使用者\Desktop\WIKI`（做法見下面的「遮路徑」）。
- **只用示範資料**：示範 WIKI 在 `docs/demo/WIKI/`，內容是虛構的餐廳自助點餐機。
- **設定資料夾用暫存的**：`WIKICHAT_CONFIG_DIR` 指到暫存資料夾，不要用平常的 `%USERPROFILE%\.wikichat`，以免錄到自己的對話。
- 錄完先抽幾格檢查，再轉 GIF；推上去前跑 `git grep -n -i "<帳號>\|<中文名>" -- . ':!web/vendor'` 確認文字也乾淨。

## 示範環境

| 檔案 | 用途 |
|---|---|
| `docs/demo/WIKI/` | 示範 WIKI：`點餐/點餐流程.md`（有圖片、內部連結、`#狀態` 錨點）、`點餐/付款規則.md`（連回點餐流程的 `#狀態`）、`菜單/菜單管理.md` |
| `docs/demo/demo-claude.js` | 假 Claude：照真的 CLI 的串流格式輸出 💬 說明、工具呼叫、逐字回答、耗時與輪數。開對話時選的身分不同，回答也不同（PM/PD 有流程圖，RD 是 API 表格） |

啟動示範 daemon（PowerShell，在專案根目錄）：

```powershell
$env:WIKICHAT_PORT = "7899"
$env:WIKICHAT_CONFIG_DIR = "$env:TEMP\wikichat-demo"
$env:WIKICHAT_WIKI_DIR = "$PWD\docs\demo\WIKI"
$env:WIKICHAT_CLAUDE = "$PWD\docs\demo\demo-claude.js"
node daemon\server.js
```

token 在 `$env:TEMP\wikichat-demo\token`，網址是 `http://127.0.0.1:7899/#token=<token>`。

## 錄製工具

用 Playwright（Claude Code 的 Playwright 外掛，`browser_run_code_unsafe` 執行下面的程式）：

- 視窗 **1100×680**、淺色模式（深色截圖時再切 `colorScheme: 'dark'`）。
- **逐格截圖**：每 125 毫秒截一張 PNG，等於 8 fps。不用錄影功能，因為逐格才能精準控制節奏。
- **遮路徑**：攔截 `/settings`，回傳通用路徑。變更 WIKI 來源的示範也是攔截 PUT、把輸入的路徑原樣回傳，不會真的改設定。
- **游標**：截圖不會出現滑鼠，所以在頁面上加一個紅色圓點跟著滑鼠移動，按下時放大。

共用的片段：

```js
async (page) => {
  const dir = '<專案>/.playwright-mcp/frames/<素材名>'   // .playwright-mcp 已被 gitignore
  await page.route('**/settings', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ wikiDir: 'C:\\Users\\使用者\\Desktop\\WIKI' }),
  }))
  await page.emulateMedia({ colorScheme: 'light' })

  let n = 0
  const shot = () => page.screenshot({ path: `${dir}/${String(n++).padStart(4, '0')}.png` })
  const hold = async k => { for (let i = 0; i < k; i++) await shot() }          // 停留 k 格
  const during = async (ms, until) => {                                           // 等待時持續截圖
    const end = Date.now() + ms
    while (Date.now() < end) {
      const t = Date.now(); await shot()
      if (until && await until()) return
      const left = 125 - (Date.now() - t); if (left > 0) await page.waitForTimeout(left)
    }
  }
  let pos = [550, 340]
  const moveTo = async (loc, frames = 7) => {                                    // 游標平滑移過去
    const b = await loc.boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2
    for (let i = 1; i <= frames; i++) { await page.mouse.move(pos[0] + (x - pos[0]) * i / frames, pos[1] + (y - pos[1]) * i / frames); await shot() }
    pos = [x, y]
  }
  const click = async loc => { await moveTo(loc); await page.mouse.down(); await shot(); await page.mouse.up(); await shot() }

  await page.goto('http://127.0.0.1:7899/#token=<token>')
  await page.waitForSelector('.role-option')
  await page.evaluate(() => {                                                     // 紅點游標
    const c = document.createElement('div'); c.id = 'demo-cursor'
    c.style.cssText = 'position:fixed;left:550px;top:340px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,80,60,.35);border:2px solid rgba(220,50,30,.9);z-index:99999;pointer-events:none;transition:transform .12s'
    document.body.append(c)
    document.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    document.addEventListener('mousedown', () => { c.style.transform = 'scale(1.8)' }, true)
    document.addEventListener('mouseup', () => { setTimeout(() => { c.style.transform = '' }, 150) }, true)
  })
  await page.mouse.move(...pos)
  // …各素材的分鏡…
}
```

注意：`browser_run_code_unsafe` 裡不能用 `require`；截圖會自動建立資料夾，重錄前先用 shell 清掉舊的影格。

## 各素材的分鏡

| 檔案 | 內容 |
|---|---|
| `ask.gif` | 停留 → 點 PM/PD → 點輸入框、逐字輸入「點餐流程是什麼？」→ 點送出 → `during(25000, 出現 .answer-stats 為止)` 錄串流 → 停留 → 移到引用標籤「點餐流程.md」點下 → 等預覽開好、停留 |
| `preview.gif` | 接在 ask.gif 之後（預覽開著「點餐流程」）：預覽往下捲看圖再捲回 → 點「付款規則」→ 點「點餐流程的「狀態」」→ 按「←」兩次 |
| `wiki-source.gif` | 攔截 `/settings` 的 GET 與 PUT → 點「變更」→ 輸入 `D:\知識庫\WIKI` → 點「儲存」。**不要按「瀏覽…」**，它會在本機跳出資料夾選擇視窗 |
| `overview.png` | PM/PD 對話捲到底、預覽開「點餐流程」並往下捲 150px，露出圖片 |
| `answer-pm.png` | PM/PD 對話捲到頂（流程圖與業務規則） |
| `answer-rd.png` | 新對話選 RD，問「訂單的 API 怎麼呼叫？」 |
| `dark.png` | PM/PD 對話，`colorScheme: 'dark'`，等 1.5 秒讓流程圖用深色重畫 |
| `role-picker.png`、`delete.png` | 只截局部元件（身分選擇列、刪除二次確認）；介面沒改就不用重拍 |

拍靜態截圖前要先把紅點游標移除，並把滑鼠移到不會觸發 hover 的地方（例如 `page.mouse.move(1095, 300)`），否則左側對話會露出刪除按鈕。

## 轉成 GIF

在影格資料夾執行（寬度縮成 960，128 色調色盤）：

```
ffmpeg -loglevel error -y -framerate 8 -i %04d.png -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 <輸出>.gif
```

檢查影格時可以把幾張拼成一張看：

```
ffmpeg -loglevel error -y -i 0040.png -i 0060.png -i 0110.png -i 0151.png -filter_complex "[0][1]hstack=2[t];[2][3]hstack=2[b];[t][b]vstack=2,scale=1600:-1" check.png
```

要檢查：WIKI 路徑是通用路徑、工具清單與輸入框沒有本機路徑、該出現的狀態（💬 步驟、思考中秒數、● 回答中、耗時）都有拍到。
