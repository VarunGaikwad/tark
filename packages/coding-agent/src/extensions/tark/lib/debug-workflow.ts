// Evidence-gated debug progression; assertions are reports, never inferred test coverage.
import type { CheckResult } from "./check-policy.ts";

export type DebugState =
	| { stage: "reproduce" }
	| { stage: "regression"; evidence: string }
	| {
			stage: "fix";
			evidence: string;
			regression: string;
			requiredCheck: "test" | null;
			verification: "pending" | "passed";
	  };

/** Track required evidence before source edits and successful verification after them. */
export class DebugWorkflow {
	state: DebugState = { stage: "reproduce" };
	private failingCheck: string | undefined;

	/** Forget evidence when the session, branch or approved plan changes. */
	reset(): void {
		this.state = { stage: "reproduce" };
		this.failingCheck = undefined;
	}

	/** Record bounded concrete evidence, a failing host check, or explicit test infeasibility. */
	report(action: "reproduce" | "regression" | "infeasible", evidence: string): void {
		if (!evidence.trim() || Array.from(evidence).length > 4096)
			throw new Error("Debug evidence must contain 1–4096 characters");
		if (action === "reproduce") {
			this.state = { stage: "regression", evidence };
			this.failingCheck = undefined;
			return;
		}
		if (this.state.stage !== "regression")
			throw new Error("First reproduce the failure or establish concrete evidence");
		if (action === "regression" && !this.failingCheck)
			throw new Error("Run a failing regression through run_checks after recording reproduction evidence");
		this.state = {
			stage: "fix",
			evidence: this.state.evidence,
			regression:
				action === "infeasible"
					? `Regression infeasible; reason and alternative verification: ${evidence}`
					: `${this.failingCheck}: ${evidence}`,
			requiredCheck: action === "regression" ? "test" : null,
			verification: "pending",
		};
	}

	/** Test edits may establish the regression; production edits require evidence and a regression decision. */
	assertWrite(path: string): void {
		if (this.state.stage === "reproduce")
			throw new Error("Debug: establish reproduction evidence with debug_workflow before editing");
		if (
			this.state.stage === "regression" &&
			!/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^/]+$/.test(path.replaceAll("\\", "/"))
		)
			throw new Error(
				"Debug: add and run a failing regression, or document infeasibility and alternative verification before fixing source",
			);
		if (this.state.stage === "fix") this.state = { ...this.state, verification: "pending" };
	}

	/** Only real host check results advance regression/verification state. */
	observe(result: CheckResult): void {
		if (
			this.state.stage === "regression" &&
			result.check === "test" &&
			!result.passed &&
			result.termination === "exit"
		)
			this.failingCheck = result.check;
		if (
			this.state.stage === "fix" &&
			(!result.passed || this.state.requiredCheck === null || result.check === this.state.requiredCheck)
		)
			this.state = { ...this.state, verification: result.passed ? "passed" : "pending" };
	}

	/** Refuse completion claims while evidence or post-fix verification is missing. */
	assertComplete(): void {
		if (this.state.stage !== "fix" || this.state.verification !== "passed")
			throw new Error(
				"Debug workflow incomplete: report reproduction, failing regression or documented infeasibility, minimal fix, and successful post-fix verification; disclose all unexecuted checks",
			);
	}
}
