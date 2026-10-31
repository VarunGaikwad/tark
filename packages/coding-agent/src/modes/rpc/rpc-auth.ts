// Authenticate the sole inherited-stdio RPC client without exposing credentials to spawned processes.
import { timingSafeEqual } from "node:crypto";

export type RpcAuthenticationResult =
	| { kind: "authenticated"; id?: string }
	| { kind: "authorized"; record: Record<string, unknown> }
	| { kind: "denied"; id?: string };

/** Pin a random client token on the private bootstrap pipe, then require it on every input record. */
export class RpcAuthenticator {
	private token: Buffer | undefined;

	/** Reject unauthenticated commands and dialog responses before either reaches session handlers. */
	authorize(value: unknown): RpcAuthenticationResult {
		if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "denied" };
		const record = value as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : undefined;
		if (record.type === "authenticate") {
			// Only the parent owns stdin before tool execution. There is no public listener or reconnect path.
			if (this.token || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token))
				return { kind: "denied", id };
			this.token = Buffer.from(record.token, "hex");
			return { kind: "authenticated", id };
		}
		if (
			!this.token ||
			typeof record.authToken !== "string" ||
			!/^[a-f0-9]{64}$/.test(record.authToken) ||
			!timingSafeEqual(this.token, Buffer.from(record.authToken, "hex")) ||
			typeof record.type !== "string"
		)
			return { kind: "denied", id };
		const { authToken: _credential, ...authorized } = record;
		return { kind: "authorized", record: authorized };
	}
}
