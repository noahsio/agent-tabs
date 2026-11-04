import { defineConfig } from "vitest/config";

export default defineConfig({
  // `vscode` exists only inside VS Code; tests mock it, and jsdom tests need it resolvable to mock it at all.
  resolve: { alias: { vscode: new URL("./test/helpers/vscodeStub.ts", import.meta.url).pathname } },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    env: {
      OMO_KIT_SECOND_AGENT_DIR: ".omo-second/agent",
      OMO_KIT_SECOND_MEMORY_HOME: ".omo-second/memory",
      OMO_KIT_SECOND_CLAUDE_DIR: ".omo-second/claude",
      OMO_KIT_SECOND_CODEGRAPH: ".omo-second/codegraph/codegraph",
      AGENT_TABS_SECOND_VSCODE: ".vscode-portable",
    },
  },
});
