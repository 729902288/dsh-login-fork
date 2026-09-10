#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const files = readdirSync(root).filter(f => f.endsWith('.ts') && f !== 'connection.ts')
let bad = 0
for (const f of files) {
  const spec = pathToFileURL(`${root}/${f}`).href
  try {
    await import(spec)
    console.log('ok   ', f)
  } catch (e) {
    bad++
    console.log('FAIL ', f, '::', e.message)
  }
}
process.exit(bad === 0 ? 0 : 1)