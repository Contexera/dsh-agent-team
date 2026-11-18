# Independent review — Session evidence and judgment

## Delivery reviewed

- Initial range: `161aeb1..8896dcb` (`feat: give the manager session evidence and a diagnosis method`).
- Reviewer: Reeve, after Tome marked the implementation Claim done.
- Full diff reviewed: Host locator, tool schema/execute/render, types, StoredSessionReader addition, all manager skill changes and references, reader script, tests, skill gate, bilingual docs and changelog.

## Evidence independently established

- Related five files / 63 tests passed: manager-session-evidence, manager-reads, manager-tools-render, manager-skills, shipping; `check:core-skills` passed.
- Current production launcher `/data/tools/dsh-022/node_modules/@deepseek-ai/dsh/lib/bin.js`, after realpath, is found by built `dshInstallAnchor`; its manifest resolves Cordis, Session persistence and JSONL persistence. No real Team Session was read.
- Standalone canonical backend reading was separately demonstrated before delivery with synthetic data, no NODE_PATH in the reader child, and unchanged storage hashes.

## Initial review findings returned at sequence 31074

1. **Truncation cannot be continued and final JSON exceeds its stated bound.** The script slices serialized data to 4,000 characters, then JSON-serializes the preview again. Nine synthetic long backslash+quote events produced `usedCharacters: 32000`, 8 returned events, actual stdout 74,150 UTF-16 code units. `dataPreview` has no continuation offset/cursor, so a narrower window never exposes the remainder.
2. **Locator mismatch and mount failures are not honest terminal errors.** A wrong log path can still return `ok:true` with only `locationMatches:false`; backend mount occurs outside read error normalization, so invalid/unreadable roots can produce a stack instead of typed JSON.
3. **Prompt/reference contradictions remain.** New skill refers the manager to unavailable `team_task board`; handoff reference still asks unconditionally after explicit authorization; its absolute ban on a test Member conflicts with standing quality responsibility; Session log is overclaimed as the only record; current-Session-only locator wording needs to distinguish previous generations.
4. `packages/agent-team/README.md` still describes five manager tools (two reads/three writes), stale relative to the current nine.

## Decisions

- Keep the Human-selected skill-plus-scripts design and exactly nine Team tools. Host locator plus standalone canonical reader is sound.
- Do not put executable scripts under the Markdown prompt-character budget. Keep Markdown budget, code review and behavioral tests for scripts; do not delete semantic qualifiers merely to fit prose.
- Production anchor approach verified on the current installation; final artifact proof must combine the actual packed script with that production-shaped anchor and synthetic storage.
- No Client, Remote activation, assembled Web or visible UI change: browser lane is not required. Existing GUI is not switched or restarted.

## Acceptance closeout

- `464a731..1458cb3` changes only `manager-session-evidence.spec.ts`. Reeve reviewed the complete diff: nine genuinely oversized escaped events share one canonical Session and one 25-event window; assertions cover final and reported lengths, every returned/omitted event, target retention, multiple bounded segments and unchanged storage hashes.
- Final independent run at `1458cb3`: manager Session evidence plus tool-manager render, two files / 43 tests passed. Together with the unchanged production-code runs above, all named locator, Host Session, stored reader, skill and render surfaces are green.
- The delivery's same-fixture mutation comparison reports old `8896dcb`: 51,560 printed versus 28,304 reported, 23 returned / two omitted and no continuation; corrected reader: 31,946 printed and reported, nine returned / 16 omitted, target retained. The new test therefore discriminates the original defect rather than merely passing on both versions.
- All review findings are closed. Reeve accepted Task #161 on 2026-11-16. No real-model management-quality claim, GUI restart, push or release follows from this acceptance.

## Round 2 — corrective delivery `8896dcb..464a731`

- Reeve reviewed the complete corrective diff: reader, tests, prompt references, bilingual package/tool documentation and changelog. The production reader now refuses a stale locator before opening bodies, classifies missing/file/permission failures, measures the serialized answer and exposes continuable event segments. Prompt contradictions and the stale manager tool count are corrected.
- Independent focused suite after a fresh build: five files / 59 tests passed (`manager-session-evidence`, `manager-reads`, `manager-skills`, `manager-session`, `stored-session-reader`). Typecheck, docs, core-skills, comments, facades, boundaries, versions and artifact checks passed.
- Actual `npm pack` produced 499 shipped entries; the extracted reader is byte-identical to the reviewed source. Built `dshInstallAnchor` resolved the current production launcher to its real DSH manifest, and plain Node executed the packed reader with that anchor and synthetic Session storage outside the repository.
- Nine oversized assistant messages containing heavy backslash/quote escaping, Chinese and emoji exercised the original multi-event shape. The packed reader printed 30,758 UTF-16 code units with an accurate `outputCharacters`, retained four events, omitted five and kept the target. Four continuation segments reconstructed the target's complete 12,464-character compact JSON exactly. No surrogate pair was split.
- A stale `--log` exited 1 with `mismatch` and no event/body field; missing root exited 2 `missing`, file root exited 2 `io`, and `/root` under the current unprivileged user exited 2 `io` for EACCES without a stack. All stored-file hashes stayed unchanged. Fixtures and markers were synthetic; no real Member Session body was read.
- Remaining review finding returned in message:e88ff83f-2f12-4afa-bb5a-a5663ab79303: the repository test named for nine long messages still uses only one oversized fixture event. Its current shape does not discriminate the original multi-event output-budget failure. Replace it with a genuinely multi-event oversized fixture and assertions for final stdout, reported size, target retention and omission; verify that the test distinguishes the old implementation. Independent behavior evidence above is green, so no production-reader change is presently indicated.
