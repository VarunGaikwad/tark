import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import tarkAccessGuard from "./tark/access-guard.ts";
import tarkAgents from "./tark/agents.ts";
import tarkQuestions from "./tark/ask-question.ts";
import tarkSetup from "./tark/recommended-tools.ts";
import tarkRepoCache from "./tark/repo-cache.ts";
import tarkResources from "./tark/resources.ts";
import tarkSound from "./tark/sound.ts";
import tarkUI from "./tark/ui.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "tark-resources", factory: tarkResources, builtin: true },
	{ name: "tark-questions", factory: tarkQuestions, builtin: true },
	{ name: "tark-agents", factory: tarkAgents, builtin: true },
	{ name: "tark-ui", factory: tarkUI, builtin: true },
	{ name: "tark-setup", factory: tarkSetup, builtin: true },
	{ name: "tark-sound", factory: tarkSound, builtin: true },
	{ name: "tark-access", factory: tarkAccessGuard, builtin: true },
	{ name: "tark-cache", factory: tarkRepoCache, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
