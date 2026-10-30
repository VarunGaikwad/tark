// Keep RPC control-plane discovery and authentication out of tool, check, job and delegated-process environments.

/** Remove reserved RPC/IPC endpoints, credentials and inherited channel-discovery variables at spawn boundaries. */
export function withoutRpcEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment)) {
		if (/RPC|IPC|^NODE_CHANNEL_|^LISTEN_(?:FDS|PID|FDNAMES)$/i.test(name)) continue;
		result[name] = value;
	}
	return result;
}
