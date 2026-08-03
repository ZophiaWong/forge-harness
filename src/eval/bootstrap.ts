import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import { runMinimalLoop } from "../core/minimalLoop.js";
import { createChildSessionRunner } from "../extensions/childSessions.js";
import {
  activateApprovedPluginHooks,
  collectPluginTrustDecisions,
  startApprovedPluginMcpServers,
} from "../extensions/pluginActivation.js";
import { preflightPlugins } from "../extensions/pluginPreflight.js";
import { createTeammateManager } from "../extensions/teammates.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import { createCliSessionTrace } from "../runtime/session.js";

export const evalRuntimeBootstrap = Object.freeze({
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
