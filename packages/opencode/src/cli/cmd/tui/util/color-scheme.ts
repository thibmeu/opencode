import fs from "fs"
import os from "os"
import { spawn } from "bun"
import type { Subprocess } from "bun"

export type ColorScheme = "dark" | "light"
export type Listener = (scheme: ColorScheme) => void

export interface ColorSchemeWatcher {
  scheme: ColorScheme | null
  subscribe(fn: Listener): () => void
  cleanup(): void
}

/**
 * Create a reactive color scheme watcher for the current platform.
 * Returns null if the platform doesn't support reactive detection.
 */
export function createColorSchemeWatcher(): ColorSchemeWatcher | null {
  switch (process.platform) {
    case "linux":
      return linux()
    case "darwin":
      return darwin()
    case "win32":
      return win32()
    default:
      return null
  }
}

// Linux: FreeDesktop Portal via gdbus monitor
function linux(): ColorSchemeWatcher | null {
  let init: Subprocess | null = null
  let proc: Subprocess | null = null
  let scheme: ColorScheme | null = null
  const listeners = new Set<Listener>()

  function notify(s: ColorScheme) {
    if (s === scheme) return
    scheme = s
    for (const fn of listeners) fn(s)
  }

  function parse(value: number): ColorScheme {
    // Portal values: 0=default, 1=dark, 2=light
    // Treat default (0) as light for consistency
    return value === 1 ? "dark" : "light"
  }

  // Initial read
  init = spawn([
    "gdbus",
    "call",
    "--session",
    "--dest",
    "org.freedesktop.portal.Desktop",
    "--object-path",
    "/org/freedesktop/portal/desktop",
    "--method",
    "org.freedesktop.portal.Settings.Read",
    "org.freedesktop.appearance",
    "color-scheme",
  ], { stdout: "pipe", stderr: "ignore" })

  const stdout = init.stdout as ReadableStream
  Promise.all([init.exited, new Response(stdout).text()]).then(([, out]) => {
    init = null
    const match = out.match(/uint32\s+(\d+)/)
    if (match) scheme = parse(parseInt(match[1]))
  }).catch(() => {
    init = null
  })

  // Monitor for changes
  proc = spawn([
    "gdbus",
    "monitor",
    "--session",
    "--dest",
    "org.freedesktop.portal.Desktop",
    "--object-path",
    "/org/freedesktop/portal/desktop",
  ], { stdout: "pipe", stderr: "ignore" })

  const stream = proc.stdout as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  function read(): void {
    reader.read().then((result) => {
      if (result.done) return
      const str = decoder.decode(result.value)
      // Signal: SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)
      if (str.includes("SettingChanged") && str.includes("color-scheme")) {
        const match = str.match(/uint32\s+(\d+)/)
        if (match) notify(parse(parseInt(match[1])))
      }
      read()
    }).catch(() => {
      proc = null
    })
  }
  read()

  return {
    get scheme() {
      return scheme
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    cleanup() {
      init?.kill()
      init = null
      proc?.kill()
      proc = null
    },
  }
}

// macOS: Watch GlobalPreferences.plist
function darwin(): ColorSchemeWatcher | null {
  let watcher: fs.FSWatcher | null = null
  let scheme: ColorScheme | null = null
  const listeners = new Set<Listener>()
  const plist = `${os.homedir()}/Library/Preferences/.GlobalPreferences.plist`

  function notify(s: ColorScheme) {
    if (s === scheme) return
    scheme = s
    for (const fn of listeners) fn(s)
  }

  async function read(): Promise<ColorScheme> {
    const proc = spawn(["defaults", "read", "-g", "AppleInterfaceStyle"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    return stdout.trim() === "Dark" ? "dark" : "light"
  }

  // Initial read
  read().then((s) => {
    scheme = s
  }).catch(() => {})

  // Watch for changes
  const watch = () => {
    watcher = fs.watch(plist, { persistent: false }, () => {
      read().then(notify).catch(() => {})
    })
    watcher.on("error", () => {
      watcher?.close()
      watcher = null
    })
  }
  
  // fs.watch throws synchronously if file doesn't exist - no way to avoid try/catch
  try { watch() } catch { return null }

  return {
    get scheme() {
      return scheme
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    cleanup() {
      watcher?.close()
      watcher = null
    },
  }
}

// Windows: Watch registry via PowerShell script using WMI events
function win32(): ColorSchemeWatcher | null {
  let proc: Subprocess | null = null
  let scheme: ColorScheme | null = null
  const listeners = new Set<Listener>()

  function notify(s: ColorScheme) {
    if (s === scheme) return
    scheme = s
    for (const fn of listeners) fn(s)
  }

  // PowerShell script that watches registry and outputs on change
  // Uses WMI RegistryValueChangeEvent for reactive notifications
  const script = `
$key = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
$val = 'AppsUseLightTheme'
function Get-Theme { 
  $v = (Get-ItemProperty -Path "Registry::$key" -Name $val -ErrorAction SilentlyContinue).$val
  if ($v -eq 0) { 'dark' } else { 'light' }
}
Get-Theme
$query = "SELECT * FROM RegistryValueChangeEvent WHERE Hive='HKEY_CURRENT_USER' AND KeyPath='SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Themes\\\\Personalize' AND ValueName='AppsUseLightTheme'"
Register-WmiEvent -Query $query -Action { Get-Theme | Write-Host } | Out-Null
while ($true) { Start-Sleep -Seconds 60 }
`.trim().replace(/\n/g, '; ')

  proc = spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
  })

  const stream = proc.stdout as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  function read(): void {
    reader.read().then((result) => {
      if (result.done) return
      const str = decoder.decode(result.value).trim()
      for (const line of str.split(/\r?\n/)) {
        if (line === "dark" || line === "light") notify(line)
      }
      read()
    }).catch(() => {
      proc = null
    })
  }
  read()

  return {
    get scheme() {
      return scheme
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    cleanup() {
      proc?.kill()
      proc = null
    },
  }
}
