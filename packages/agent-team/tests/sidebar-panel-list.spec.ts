/**
 * The Team-mode rail standdown in the Client's `sidebar.module.css` hides the
 * shipped panel rail by DOM shape: a `nav` carrying the CSS-module `panelList`
 * class. That class name belongs to the Harness checkout, and `test:browser` —
 * the only lane that would notice a rename — never runs in CI, so the coupling
 * is pinned here against the shipped source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessDir } from '../../../scripts/harness-dir.mjs'

const sidebarRoot = join(harnessDir, 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx')

describe('shipped sidebar panel rail', () => {
  it('keeps the panelList class on a nav element', () => {
    expect(readFileSync(sidebarRoot, 'utf8')).toMatch(/<nav[^>]*className=\{css\.panelList\}/)
  })
})
