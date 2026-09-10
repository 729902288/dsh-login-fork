#!/usr/bin/env node
/**
 * Build the dsh-login browser client bundle (option A, DSH >= 0.1.5-alpha.1).
 *
 * Under option A the plugin does NOT take over /api and does NOT re-stamp the
 * shipped connection client - the native `connection` row owns the wire, so the
 * browser half is a standalone `dsh.client` contribution: one module-loader
 * registration for the plugin id that materializes the settings-panel factory
 * (src/settings-panel.client.js, plain JS, appended verbatim). The factory
 * registers settings over the native slots/locale; React and the UI primitives
 * resolve through the platform module-table seeds.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = '@islibaodong/dsh-login'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const panelSource = readFileSync(join(repoRoot, 'src/settings-panel.client.js'), 'utf8')

if (!panelSource.includes('settings.section') || panelSource.includes('dsh-login/connection')) {
  throw new Error('settings-panel.client.js: settings.section missing or a stale connection re-export present')
}
const out = `;window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: function (require) { return (${panelSource})(require); } });\n`
const dest = resolve(repoRoot, 'dist', 'client.js')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, out)
console.log(`wrote ${dest} (${String(out.length)} chars)`)