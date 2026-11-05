import { mergeConfig } from 'vitest/config'
import base from '../../../../../vitest.config.ts'

export default mergeConfig(base, {
  test: {
    projects: [{
      extends: true,
      test: { name: 'context-scenarios', include: ['.scratch/archive/2026-11/agent-tools-context-rendering/harness/context-scenarios.spec.ts'] },
    }],
  },
})
