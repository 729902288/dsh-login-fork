#!/usr/bin/env node
// Build the dsh-login host bundle (option A, DSH ≥ 0.1.5-alpha.1).
//
// The /api carrier takeover (`src/connection.ts`) and its client re-stamp
// (`src/connection.client.ts`) were removed; the native `connection` row owns
// /api. Only `src/index.ts` (the Cordis plugin) is bundled to `dist/index.js`.
// package.json `main` = `dist/index.js`.
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entries = [
  ['src/index.ts', 'dist/index.js'],
]

await mkdir(resolve(repoRoot, 'dist'), { recursive: true })

for (const [, output] of entries) {
  await rm(resolve(repoRoot, output), { force: true })
  await rm(resolve(repoRoot, `${output}.map`), { force: true })
}

for (const [entry, output] of entries) {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    external: ['@deepseek-ai/*'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 不生成 sourcemap：产物要随镜像到客户机器上，而带 sourcesContent 的 map
    // 等于把完整源码一起发出去。
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
}