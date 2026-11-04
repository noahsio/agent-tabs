# Public Agent Tabs snapshot

Status: FROZEN. The owner-approved source of truth is `/tmp/agent-tabs-public-brief.md`.
Workspace: `/tmp/agent-tabs-public`. Evidence: `/tmp/agent-tabs-public-evidence`.
Source snapshot: git archive of HEAD `3f48b93`; source is read-only.

## Design

Keep the existing extension and kit contracts, parameterize paths at their existing
boundaries, and add a small installer around the current build/package commands.
The alternative of introducing a new configuration framework or reworking the UI
adds migration risk without helping this publication task. No UI behavior redesign.

All writes and test caches must stay in the workspace or `/tmp` scratch directories.
Do not operate a real OmO host, change real user settings, or push.
Tests use scratch HOME and local fixtures. Live/model tests remain opt-in and are
not run against the owner's services.

## Acceptance criteria

- AC1: Snapshot contains only tracked HEAD content plus requested public changes,
  with no inherited git history, dist, dependencies, VSIX, hidden superpowers data,
  private notes/plans, specified private specs, mining/live tools or old verifier.
- AC2: Remaining design/spec material and fixtures contain no owner paths,
  private names, private infrastructure or captured personal session text.
  Guard whitelist is empty; public guard command grammar coverage is preserved.
- AC3: License is MIT, copyright `2026 noahsio`; package and lock metadata agree,
  publisher remains local.
- AC4: resolveEnv(name, home) keeps system/default HOME paths. Second exists only
  with OMO_KIT_SECOND_AGENT_DIR, with optional OMO_KIT_SECOND_MEMORY_HOME,
  OMO_KIT_SECOND_CLAUDE_DIR and OMO_KIT_SECOND_CODEGRAPH, absolute or HOME-relative.
  ENV_NAMES reflects availability. CodeGraph defaults to PATH. Consumers,
  declarations, sandbox protection and tests use the same paths.
- AC5: Tests configure neutral second paths. Live tests use environment-driven
  config, provider/model selection and retain their explicit live opt-in gates.
- AC6: scripts/install.sh performs npm ci, build, package and verification.
  AGENT_TABS_CODE overrides the default system macOS CLI or code on PATH.
  AGENT_TABS_SECOND_VSCODE explicitly enables a portable second installation;
  AGENT_TABS_EXTENSIONS_DIR and AGENT_TABS_USER_DATA_DIR isolate runs.
  AGENT_TABS_SKIP_OMO_SETUP=1 skips the default system setup invocation.
- AC7: Isolated install targets only the supplied VS Code directories and a
  temporary HOME. It installs local.agent-tabs, runs default kit setup, reports
  success, and leaves both real settings files byte-identical.
- AC8: setup defaults to system, runs without preinstalled Claude/CodeGraph,
  creates agent settings/wrapper, warns for absent optional tools, and never
  clones/updates superpowers unless --superpowers is explicitly set.
  Opt-in retains the existing setup logic; settings UI code stays.
- AC9: Summary reports written paths, added/skipped skills, CodeGraph status
  with install hint, hooks, omo.jsonc and omo-system wrapper. Regression tests
  cover default setup and explicit opt-in setup without weakening existing coverage.
- AC10: Public env examples have template HOME paths and no gateway credentials.
- AC10: Public env examples have template HOME paths and no gateway credentials.
  omo.roles.example.jsonc contains the exact role/model routing from the brief,
  quick reflection category and disabled telemetry.
- AC11: Concise Russian README documents prerequisites and recommended VS Code
  install command, setup flags, second overrides, superpowers consent, examples,
  normal/Chrome/live verification and real limitations. No Marketplace claims.
- AC12: npm ci, npx tsc --noEmit, npm test and npm run build pass on current code.
  Raw command logs and fresh verification map every criterion to current evidence.
- AC13: Private-string/secret scans pass, hidden superpowers is absent, and a new
  main branch has exactly one English commit authored/committed by
  `noahsio <noahsio@users.noreply.github.com>`, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, and origin
  `git@github.com-n:noahsio/agent-tabs.git`. No push. Final report includes commit,
  file count and commands.

## Implementation ownership

- Builder: installer, metadata/license, examples, README, integration and evidence.
- Builder also owns kit, sanitization and live-test configuration: child spawning
  is unavailable at the current nesting depth.
- Verification: a fresh pass reads current code and reruns checks. A separate
  verifier session is unavailable due to the same tool limit; report this explicitly.

## Verification sequence

Run targeted regression red tests before changed behavior. Then run clean install,
typecheck, full normal tests and build. Run installer in fresh scratch HOME and
explicit VS Code data/extension dirs; compare settings hashes. Scan release files.
Write evidence, obtain fresh verification, fix any failures and reverify affected
criteria. Initialize and commit only the public tree once gates pass.
