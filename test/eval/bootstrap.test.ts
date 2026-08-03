import { describe, expect, it } from "vitest";

import { loadRepoPromptAssets } from "../../src/context/promptAssembly.js";
import { runMinimalLoop } from "../../src/core/minimalLoop.js";
import { evalRuntimeBootstrap } from "../../src/eval/bootstrap.js";
import { createChildSessionRunner } from "../../src/extensions/childSessions.js";
import {
  activateApprovedPluginHooks,
  collectPluginTrustDecisions,
  startApprovedPluginMcpServers,
} from "../../src/extensions/pluginActivation.js";
import { preflightPlugins } from "../../src/extensions/pluginPreflight.js";
import { createTeammateManager } from "../../src/extensions/teammates.js";
import { createDefaultPermissionPolicy } from "../../src/governance/defaultPolicy.js";
import { createCliSessionTrace } from "../../src/runtime/session.js";

describe("eval bootstrap parity", () => {
  it("binds directly to the production Runtime and extension factories", () => {
    expect(evalRuntimeBootstrap).toMatchObject({
      activateApprovedPluginHooks,
      collectPluginTrustDecisions,
      createChildSessionRunner,
      createCliSessionTrace,
      createDefaultPermissionPolicy,
      createTeammateManager,
      loadRepoPromptAssets,
      preflightPlugins,
      runMinimalLoop,
      startApprovedPluginMcpServers,
    });
  });
});
