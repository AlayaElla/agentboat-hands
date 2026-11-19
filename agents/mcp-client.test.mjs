import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { client } from './mcp-client.mjs'

test('malformed server output rejects the pending request', async () => {
  const service = client({ command: process.execPath, args: ['-e', "process.stdin.once('data', () => console.log('invalid'))"] })
  try { await assert.rejects(service.rpc('ping'), /Invalid JSON/) } finally { await service.close() }
})

test('shared MCP client closes after a server has already exited and rejects later requests', { timeout: 5000 }, async () => {
  const service = client({ command: process.execPath, args: ['-e', 'process.exit(3)'] })
  await once(service.child, 'exit')
  await service.close()
  await service.close()
  await assert.rejects(service.rpc('ping'), /MCP exited 3/)
})
