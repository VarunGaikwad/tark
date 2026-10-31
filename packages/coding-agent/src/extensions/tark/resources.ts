// Contribute bundled resources through Pi's existing discovery and disable flags.
import { join } from "node:path";
import { parseArgs } from "../../cli/args.ts";
import { type ExtensionAPI, getTarkResourcesDir } from "./host.ts";

export default function tarkResources(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => {
		const root = getTarkResourcesDir();
		const args = parseArgs(process.argv.slice(2));
		return {
			skillPaths: args.noSkills ? [] : [join(root, "skills")],
			promptPaths: args.noPromptTemplates ? [] : [join(root, "prompts")],
			themePaths: args.noThemes ? [] : [join(root, "themes")],
		};
	});
}
