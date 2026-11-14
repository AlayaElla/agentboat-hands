import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

export const desktopDirectory = () => process.env.HANDS_DESKTOP_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AgentBoat', 'hands-desktop')
const integer = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`)
}
const coordinate = (value, name) => integer(value, name, -100000, 100000)
const windowId = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) throw new Error('window_id must be a decimal window handle from desktop_windows.')
}
const keyPattern = /^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|CTRL|ALT|SHIFT|WIN|ENTER|TAB|ESC|SPACE|BACKSPACE|DELETE|INSERT|HOME|END|PAGEUP|PAGEDOWN|LEFT|RIGHT|UP|DOWN|PRINTSCREEN)$/i

// Validate again in the agent: its HTTP endpoint is also a trust boundary.
export function validateDesktop(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.')
  if (!Object.hasOwn(desktopTools, name)) throw new Error(`Unknown desktop tool: ${name}`)
  const spec = desktopTools[name]
  for (const k of Object.keys(args)) if (!Object.hasOwn(spec.properties, k)) throw new Error(`Unknown argument: ${k}`)
  for (const k of spec.required) if (args[k] === undefined) throw new Error(`Missing required argument: ${k}`)
  if (args.window_id !== undefined) windowId(args.window_id)
  if (name === 'desktop_screenshot') {
    const mode = args.target ?? 'desktop'
    if (!['desktop', 'monitor', 'window', 'region'].includes(mode)) throw new Error('Invalid screenshot target.')
    if (mode === 'window') windowId(args.window_id)
    if (mode === 'monitor') integer(args.monitor, 'monitor', 0, 127)
    if (mode === 'region') for (const k of ['x', 'y', 'width', 'height']) k === 'x' || k === 'y' ? coordinate(args[k], k) : integer(args[k], k, 1, 32768)
    for (const k of ['monitor', 'window_id', 'x', 'y', 'width', 'height']) {
      if (args[k] !== undefined && !(mode === 'window' && k === 'window_id') && !(mode === 'monitor' && k === 'monitor') && !(mode === 'region' && ['x', 'y', 'width', 'height'].includes(k))) throw new Error(`${k} does not apply to ${mode} capture.`)
    }
    if (args.max_dimension !== undefined) integer(args.max_dimension, 'max_dimension', 64, 4096)
  }
  if (name === 'desktop_mouse') {
    if (!['move', 'click', 'double_click', 'drag', 'scroll'].includes(args.action)) throw new Error('Invalid mouse action.')
    coordinate(args.x, 'x'); coordinate(args.y, 'y')
    if (args.button !== undefined && !['left', 'right', 'middle'].includes(args.button)) throw new Error('Invalid mouse button.')
    if (args.action === 'drag') { coordinate(args.to_x, 'to_x'); coordinate(args.to_y, 'to_y') }
    else if (args.to_x !== undefined || args.to_y !== undefined || args.duration_ms !== undefined) throw new Error('Drag arguments require action=drag.')
    if (args.duration_ms !== undefined) integer(args.duration_ms, 'duration_ms', 50, 3000)
    if (args.action === 'scroll') {
      integer(args.delta, 'delta', -12000, 12000)
      if (args.delta === 0) throw new Error('delta must not be zero.')
      if (args.axis !== undefined && !['vertical', 'horizontal'].includes(args.axis)) throw new Error('Invalid scroll axis.')
    } else if (args.delta !== undefined || args.axis !== undefined) throw new Error('Scroll arguments require action=scroll.')
  }
  if (name === 'desktop_type' && (typeof args.text !== 'string' || !args.text.length || args.text.length > 10000 || args.text.includes('\0'))) throw new Error('text must contain 1 to 10000 characters without NUL.')
  if (name === 'desktop_key' && (!Array.isArray(args.keys) || !args.keys.length || args.keys.length > 8 || args.keys.some(k => typeof k !== 'string' || !keyPattern.test(k)) || new Set(args.keys.map(k => k.toUpperCase())).size !== args.keys.length)) throw new Error('keys must contain 1 to 8 distinct supported key names.')
  return args
}

export async function callDesktop(name, args, { platform = process.platform, directory = desktopDirectory() } = {}) {
  if (platform !== 'win32') throw new Error(`Desktop tools are 暂不支持 (not yet supported) on ${platform}; Windows is required.`)
  validateDesktop(name, args)
  let endpoint
  try { endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json'), 'utf8')) } catch { throw new Error('Desktop agent is unavailable. Run start-desktop.ps1 in the logged-in user session (see README.md).') }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid desktop agent credentials.')
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: '/call', method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; let size = 0
      res.on('data', c => { size += c.length; if (size > 6_000_000) res.destroy(new Error('Desktop reply is too large.')); else chunks.push(c) })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (res.statusCode !== 200) throw new Error(result.error || `Desktop agent HTTP ${res.statusCode}`)
          resolve(result)
        } catch (e) { reject(e) }
      })
    })
    req.setTimeout(20000, () => req.destroy(new Error('Desktop request timed out; input outcome is unknown. Do not automatically retry.')))
    req.on('error', e => reject(new Error(`Desktop agent: ${e.message}. Input outcome may be unknown; do not automatically retry.`)))
    req.end(JSON.stringify({ name, args }))
  })
}

const str = description => ({ type: 'string', description })
const num = description => ({ type: 'integer', description })
const targetWindow = { window_id: str('Decimal handle from desktop_windows; must still be foreground for input') }
const definitions = {
  desktop_displays: ['List monitors, their physical pixel bounds, DPI and the virtual desktop bounds.', {}, []],
  desktop_windows: ['List visible top-level windows: handle, title, process, physical bounds, minimized and foreground state.', {}, []],
  desktop_focus: ['Restore and foreground a window, temporarily attaching input threads when called from the background. Confirms the foreground handle afterwards; returns an error if Windows refuses.', targetWindow, ['window_id']],
  desktop_screenshot: ['Capture desktop, monitor, window (PrintWindow), or region as MCP PNG. Physical screen = bounds origin + image pixel / scaleX or scaleY. Default maximum dimension 1600; PNG at most 3.5 MB.', {
    target: { type: 'string', enum: ['desktop', 'monitor', 'window', 'region'] }, ...targetWindow,
    monitor: num('Zero-based monitor index from desktop_displays'), x: num('Physical screen x, may be negative'), y: num('Physical screen y, may be negative'), width: num('Region width in physical pixels'), height: num('Region height in physical pixels'), max_dimension: num('Maximum output dimension, 64..4096; default 1600'),
  }, []],
  desktop_mouse: ['Move, click (left/right/middle), double click, drag, or scroll within a specified foreground window. All coordinates are physical screen pixels. Aborts on focus loss or another window covering the point; focus explicitly first.', {
    ...targetWindow, action: { type: 'string', enum: ['move', 'click', 'double_click', 'drag', 'scroll'] }, x: num('Physical screen x'), y: num('Physical screen y'), button: { type: 'string', enum: ['left', 'right', 'middle'] }, to_x: num('Drag endpoint x'), to_y: num('Drag endpoint y'), duration_ms: num('Drag duration 50..3000, default 300'), delta: num('Wheel units, positive up/right, negative down/left; 120 per notch'), axis: { type: 'string', enum: ['vertical', 'horizontal'] },
  }, ['window_id', 'action', 'x', 'y']],
  desktop_type: ['Type Unicode text, including Chinese, in a foreground window using SendInput, without changing the clipboard. Aborts on focus loss.', { ...targetWindow, text: str('1..10000 UTF-16 code units') }, ['window_id', 'text']],
  desktop_key: ['Press a chord then release all keys. Key names: A-Z, 0-9, F1-F24, CTRL ALT SHIFT WIN ENTER TAB ESC SPACE BACKSPACE DELETE INSERT HOME END PAGEUP PAGEDOWN LEFT RIGHT UP DOWN PRINTSCREEN.', { ...targetWindow, keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, ['window_id', 'keys']],
}
export const desktopTools = Object.fromEntries(Object.entries(definitions).map(([name, [description, properties, required]]) => [name, { description, properties, required, run: args => callDesktop(name, args) }]))
