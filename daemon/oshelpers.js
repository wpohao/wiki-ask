import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PICK_TIMEOUT_MS = 5 * 60_000

// The selected path is printed as base64 UTF-8 so the cp950 console cannot garble Chinese folder names.
// The daemon has no foreground rights once the user is in the browser, so an unshown TopMost owner is not
// enough: the dialog opens behind the browser. The owner is shown (invisible) and takes the foreground by
// attaching to the foreground window's input queue.
const PICK_FOLDER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace WikiAsk -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$self = [WikiAsk.Win32]::GetCurrentThreadId()
$fg = [WikiAsk.Win32]::GetWindowThreadProcessId([WikiAsk.Win32]::GetForegroundWindow(), [IntPtr]::Zero)
$attached = $fg -ne 0 -and $fg -ne $self -and [WikiAsk.Win32]::AttachThreadInput($self, $fg, $true)
[void][WikiAsk.Win32]::SetForegroundWindow($owner.Handle)
$owner.Activate()
if ($attached) { [void][WikiAsk.Win32]::AttachThreadInput($self, $fg, $false) }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '選擇 WIKI 資料夾'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))
}
$owner.Dispose()
`

export function decodePickerOutput(stdout) {
  const trimmed = String(stdout || '').trim()
  return trimmed ? Buffer.from(trimmed, 'base64').toString('utf8') : null
}

// explorer.exe splits an unquoted argument at commas (its `/select,<path>` syntax), and Node only quotes
// arguments that contain spaces, so a path like `a,b.md` fell apart. Always quote it ourselves; Windows
// paths cannot contain `"`.
export function explorerArgs(absPath) {
  return [`"${absPath}"`]
}

export async function openWithDefaultApp(absPath) {
  // explorer.exe exits with 1 even when it succeeds, so its exit code is ignored.
  const child = spawn('explorer.exe', explorerArgs(absPath), {
    detached: true, stdio: 'ignore', windowsHide: false, shell: false, windowsVerbatimArguments: true,
  })
  child.on('error', () => {})
  child.unref()
}

export async function pickFolder() {
  const encoded = Buffer.from(PICK_FOLDER_SCRIPT, 'utf16le').toString('base64')
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    windowsHide: true, timeout: PICK_TIMEOUT_MS, encoding: 'utf8',
  })
  return decodePickerOutput(stdout)
}
