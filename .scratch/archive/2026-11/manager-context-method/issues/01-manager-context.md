# 01 — Manager context and method

**What to deliver:** a coherent manager persona and on-demand knowledge set for evidence-driven Team design, event loops and prompt-led memory upkeep, with actual model-input coverage.
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:** ../README.md; ../spec.md; repository AGENTS.md; docs/AGENTS.md for maintained edits; current manager persona in cordis.patch.yml; packages/agent-team/manager-skills/**; Member source skills member-memory-manager, team-domain-model and project-subscriptions; packages/agent-team/src/manager-context.ts; manager-skills.spec.ts and member-skills.spec.ts; docs/architecture/tools-and-preset.md; docs/development/start-and-checks.md. Spec is binding intent; code/tests are current behavior.
**Background:** source discussion thread:4434d3fd-8ae1-4a41-b282-3238e8c210e8, especially Human's two 2026-11-16 afternoon messages; no need to reconstruct earlier work history or read live Session logs.
**Boundaries:** writable manager persona, manager skills, related tests/check expectations and maintained docs/README/changelog. Do not modify core Member skills, current Team configuration/private files, permissions, lifecycle, Harness checkout, or UI. If code changes outside this scope prove necessary, report the evidence before broadening. Work on the clean shared master from 564750c; stage only owned paths and do not push. Reeve handles independent verification and final integration.

- [x] Resident prompt routes to current Team evidence, relevant skills and meaningful memory upkeep without loading all reference detail.
- [x] Three Member-derived knowledge areas are adapted to manager identity and available tools; event loops, evidence-based least structure and authority boundaries are internally consistent.
- [x] Actual model-input test proves manager catalog + skill tool in the first request and loaded body in a later request; existing Member/ordinary isolation remains intact.
- [x] Relevant checks pass and maintained docs reflect the shipped skill set and routing. Report counts/budgets where they help review.

**Evidence to return:** pinned diff/commit, checks actually run and results, any unverified live-runtime scope or deviations, and short explanation of the knowledge layering. Mark review at delivery; Reeve independently accepts.
