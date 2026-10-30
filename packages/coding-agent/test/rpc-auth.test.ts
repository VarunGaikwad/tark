// RPC authentication rejects spawned-process commands and dialog replies before session dispatch.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RpcAuthenticator } from "../src/modes/rpc/rpc-auth.ts";

describe("private-stdio RPC authentication", () => {
	it("requires bootstrap, rejects malformed tokens and pins the first client for this process", () => {
		const auth = new RpcAuthenticator();
		const token = randomBytes(32).toString("hex");
		expect(auth.authorize({ type: "prompt", message: "/approve-plan" })).toEqual({ kind: "denied", id: undefined });
		for (const invalid of [null, [], "secret", { type: "authenticate", token: "short" }])
			expect(auth.authorize(invalid).kind).toBe("denied");
		expect(auth.authorize({ id: "bootstrap", type: "authenticate", token })).toEqual({
			kind: "authenticated",
			id: "bootstrap",
		});
		expect(auth.authorize({ type: "authenticate", token: randomBytes(32).toString("hex") }).kind).toBe("denied");
		expect(auth.authorize({ type: "authenticate", token }).kind).toBe("denied");
	});

	it("authenticates commands and dialog replies without forwarding credentials to session handlers", () => {
		const auth = new RpcAuthenticator();
		const token = randomBytes(32).toString("hex");
		auth.authorize({ type: "authenticate", token });
		for (const record of [
			{ type: "prompt", message: "/approve-plan" },
			{ type: "extension_ui_response", id: "dialog", value: "Approve & start code" },
		]) {
			expect(auth.authorize(record).kind).toBe("denied");
			expect(auth.authorize({ ...record, authToken: "0".repeat(64) }).kind).toBe("denied");
			expect(auth.authorize({ ...record, authToken: token })).toEqual({ kind: "authorized", record });
		}
	});

	it("does not accept a token from a previous server process", () => {
		const previous = randomBytes(32).toString("hex");
		const auth = new RpcAuthenticator();
		auth.authorize({ type: "authenticate", token: randomBytes(32).toString("hex") });
		expect(auth.authorize({ type: "prompt", message: "/approve-plan", authToken: previous }).kind).toBe("denied");
	});
});
