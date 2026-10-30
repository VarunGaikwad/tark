import { readFileSync } from "node:fs";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { renderConfigSchemas } from "../scripts/generate-schemas.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { parseAgentConfig } from "../src/extensions/tark/lib/agents.ts";
import { defaultSoundPreferences, validateSoundPreferences } from "../src/extensions/tark/lib/sound-events.ts";

const validator = Compile(SettingsSchema);

describe("Tark settings schema", () => {
	it("describes all settings in the generated artifact", () => {
		const rendered = renderConfigSchemas().get("schemas/settings.schema.json")!;
		expect(readFileSync(new URL("../schemas/settings.schema.json", import.meta.url), "utf8")).toBe(rendered);
		const schema = JSON.parse(rendered);
		expect(Object.keys(schema.properties.tark.properties).sort()).toEqual([
			"agentSetup",
			"auto_profile",
			"model",
			"recommendedTools",
			"small_model",
			"sound",
			"subagent_model",
			"subagent_variant_overrides",
		]);
		const tark = {
			model: "test/main",
			small_model: "test/small",
			subagent_model: "test/subagent",
			auto_profile: false,
			subagent_variant_overrides: { code: { model: "test/code", effort: "medium" } },
			recommendedTools: "enabled",
			agentSetup: "disabled",
			sound: defaultSoundPreferences(),
		};
		expect(validator.Check({ tark })).toBe(true);
		expect(() => parseAgentConfig(tark)).not.toThrow();
		expect(Compile(schema).Check({ tark })).toBe(true);
		expect(validator.Check({ theme: "orange", extensionSetting: true, tark: {} })).toBe(true);
	});
	it.each([
		null,
		{ model: "bare-model" },
		{ small_model: "test/model with spaces" },
		{ subagent_model: "/model" },
		{ auto_profile: "yes" },
		{ recommendedTools: true },
		{ agentSetup: "later" },
		{ subagent_variant_overrides: { unknown: {} } },
		{ subagent_variant_overrides: { code: { effort: "huge" } } },
		{ subagent_variant_overrides: { plan: { typo: true } } },
	])("rejects malformed agent settings: %j", (tark) => {
		expect(validator.Check({ tark })).toBe(false);
		expect(() => parseAgentConfig(tark)).toThrow();
	});
	it("flags unsupported top-level settings in the editor but ignores them at runtime", () => {
		for (const tark of [
			{ typo: true },
			{ delegate_exploration: false },
			{ codeHealth: { enabled: true, enableAiReview: true, enableRuff: true } },
			{ codeHealth: null },
			{ codeHealth: { mode: "invalid" } },
		]) {
			expect(validator.Check({ tark })).toBe(false);
			expect(parseAgentConfig(tark)).toEqual({});
		}
	});
	it("matches runtime sound validation for partial and malformed preferences", () => {
		for (const sound of [{}, { enabled: true }, { events: { failure: false } }, { minimumDurationMs: 0 }]) {
			expect(validator.Check({ tark: { sound } })).toBe(true);
			expect(() => validateSoundPreferences(sound)).not.toThrow();
		}
		for (const sound of [
			null,
			[],
			{ enabled: "yes" },
			{ events: null },
			{ events: { attention: 1 } },
			{ minimumDurationMs: -1 },
			{ minimumDurationMs: 3_600_001 },
		]) {
			expect(validator.Check({ tark: { sound } })).toBe(false);
			expect(() => validateSoundPreferences(sound)).toThrow();
		}
	});
});
