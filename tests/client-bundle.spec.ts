import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Bundle guard (option A): the dsh-login package ships a standalone browser
 * bundle (`dist/client.js`) as its `dsh.client` contribution — the 设置→用户管理/账户
 * settings panel over the native connection row (which owns /api).
 * The client-modules scanner discovers browser halves from a package's own
 * `dsh.client` declaration + built `exports["./client"]` artifact.
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
  dsh: { client?: { platform?: string; inject?: string[] } }
}

describe('dsh-login browser client bundle (merge gate, Option A)', () => {
  it('declares dsh.client for the web platform', () => {
    expect(pkg.dsh.client).toBeDefined()
    expect(pkg.dsh.client!.platform).toBe('web')
    expect(Array.isArray(pkg.dsh.client!.inject)).toBe(true)
  })

  it('exports a built ./client bundle', () => {
    const client = pkg.exports['./client']
    expect(typeof client).toBe('string')
    const bundle = readFileSync(join(repoRoot, client as string), 'utf8')
    // Module-loader handoff stamped with dsh-login's package id (the scanner
    // keys boot-graph rows by the entry/package name).
    expect(bundle).toContain('window.__ModuleLoader__.load')
    expect(bundle).toContain('"@islibaodong/dsh-login"')
  })

  it('is self-contained: no cross-plugin require of the shipped connection bundle', () => {
    const client = pkg.exports['./client'] as string
    const bundle = readFileSync(join(repoRoot, client), 'utf8')
    expect(bundle).not.toContain("require('@deepseek-ai/dsh-client-connection")
    expect(bundle).not.toContain('require("@deepseek-ai/dsh-client-connection')
  })

  it('carries the settings-panel as the single plugin registration', () => {
    const client = pkg.exports['./client'] as string
    const bundle = readFileSync(join(repoRoot, client), 'utf8')
    // Option A: one registration — the settings panel (a standalone dsh.client;
    // the native connection row owns /api, so there is no wire re-stamp).
    expect(bundle.match(/window\.__ModuleLoader__\.load\(/g)).toHaveLength(1)
    // The graph-row registration wraps the settings panel directly.
    expect(bundle).toContain('window.__ModuleLoader__.load({ id: "@islibaodong/dsh-login"')
    expect(bundle).not.toContain('dsh-login/connection')
    expect(bundle).toContain('settings.section')
    expect(bundle).toContain('/api/auth/admin/users/disable')
    // Theme-following styles: the panel must skin via --dsw-alias-* tokens,
    // injected as a pre-tagged deduped style (framework bundle-preset shape).
    expect(bundle).toContain('--dsw-alias-label-primary')
    expect(bundle).toContain('--dsw-alias-border-l2')
    expect(bundle).toContain('dataset.pluginCss')
    expect(bundle).toContain('settings-panel.css')
  })

  it('declares the settings-panel dependency edges in dsh.client.inject', () => {
    // Convention (official + third-party settings plugins): inject lists the
    // PACKAGE ids owning the services the browser half needs — not service
    // names. Informational for the boot graph; the runtime fiber's own
    // exported inject ('slots', 'locale') stays authoritative.
    expect(pkg.dsh.client!.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ])
  })
})
