# Public Agent Tabs snapshot evidence

Status: PASS after the final commit verification. The current tree was checked
after the last source and fixture change. A separate verifier session was
unavailable at the nesting limit, as recorded in the frozen specification; the
fresh verification pass was run in this session.

## Acceptance criteria

| Criterion | Verdict | Current evidence |
| --- | --- | --- |
| AC1 | PASS | The frozen source snapshot and public-only edits are under the target tree; generated `dist`, `node_modules`, VSIX, and inherited `.git` artifacts were removed before initialization. See `raw/tree-cleanup.txt`, the final one-commit check, and `raw/scans.txt`. |
| AC2 | PASS | Public guard grammar and empty whitelist are preserved in `kit/guard/`, sanitized docs and fixtures remain in `docs/`, `setup/`, and `test/`, and the private-string scan is zero. See `raw/scans.txt`. |
| AC3 | PASS | `LICENSE`, `package.json`, and `package-lock.json` carry MIT / `2026 noahsio`; package metadata keeps the local publisher. |
| AC4 | PASS | `kit/lib/envs.mjs` is the path boundary; its consumers, declarations, sandbox protection, and tests use the same system/optional-second environment model. |
| AC5 | PASS | `vitest.config.mts` supplies neutral second paths, and `test/live/config.ts` plus the live suites read environment-driven settings, providers, models, and keys while retaining `AGENT_TABS_LIVE=1` gates. |
| AC6 | PASS | `scripts/install.sh` runs clean install, build, package, installation, verification, isolated VS Code paths, optional second installation, and the setup skip flag. |
| AC7 | PASS | The real isolated install passed for system and portable VS Code, installed `local.agent-tabs`, ran default setup, and kept all three real settings hashes byte-identical. See `raw/install.txt`. |
| AC8 | PASS | `setup/setup-omo.mjs` defaults to system, works without optional tools, creates the settings and wrapper, warns about absent tools, and only clones Superpowers after `--superpowers`; regression coverage is in `test/kit/setup.test.ts`. |
| AC9 | PASS | Setup output reports paths, skills, CodeGraph status and hint, hooks, `omo.jsonc`, and the wrapper; default and opt-in setup tests cover the summary and behavior. |
| AC10 | PASS | `setup/env.system.example.json`, `setup/env.second.example.json`, and `setup/omo.roles.example.jsonc` use template paths and neutral values; the role routing, quick reflection category, and disabled telemetry match the approved brief. |
| AC11 | PASS | `README.md` is concise Russian documentation for prerequisites, recommended VS Code installation, setup flags, second-environment overrides, Superpowers consent, examples, normal/Chrome/live verification, and limitations without Marketplace claims. |
| AC12 | PASS | `npm ci`, `npx tsc --noEmit`, `npm test`, and `npm run build` passed on the current tree: 89 files passed, 21 skipped; 1702 tests passed, 57 skipped; build exit 0. See `raw/final-required.txt`. |
| AC13 | PASS | Current scans report zero private strings, zero secret-pattern matches, and zero hidden `.superpowers` directories. The final repository check verifies one `main` commit with the required author, committer, trailer, origin, and no push. See `raw/scans.txt` and the post-commit verification output. |

## Verification notes

The full command emitted two existing esbuild warnings about `import.meta` in
CJS output; it still exited 0. `npm ci` reported two moderate audit findings.
The inherited checkpointer timing sensitivity under unconstrained parallelism is
documented in the external verification problems log; the bounded final run
passed without changing checkpointer code.
