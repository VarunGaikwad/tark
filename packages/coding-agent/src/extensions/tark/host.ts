// Narrow host imports keep bundled Tark features out of the public SDK barrel.
export { getAgentDir, getTarkInvocation, getTarkResourcesDir } from "../../config.ts";
export type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
export { KeybindingsManager } from "../../core/keybindings.ts";
export type { SessionEntry } from "../../core/session-manager.ts";
export { SettingsManager } from "../../core/settings-manager.ts";
export { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
export type { Theme } from "../../modes/interactive/theme/theme.ts";
