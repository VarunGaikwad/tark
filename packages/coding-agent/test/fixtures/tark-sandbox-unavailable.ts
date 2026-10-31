// Invoked inside real bubblewrap with every supported bubblewrap executable path hidden.
import { executeReadOnlySandbox } from "../../src/extensions/tark/lib/command-execution.ts";

try {
	await executeReadOnlySandbox(
		process.execPath,
		["-e", "console.log('UNRESTRICTED COMMAND EXECUTED')"],
		process.argv[2],
	);
	process.exitCode = 1;
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("Filesystem isolation unavailable")) throw error;
	console.log("unavailable backend blocked before command execution");
}
