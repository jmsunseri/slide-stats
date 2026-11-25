import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS as watchDefaults } from "../src/embeddedjs/lib/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);
const phoneDetector = require("../src/pkjs/lib/detector.js");

test("generated PKJS detector stays in sync with the watch detector", () => {
	assert.deepEqual(phoneDetector.DEFAULTS, watchDefaults);
	execFileSync(process.execPath, [
		path.join(ROOT, "tools/generate-pkjs-detector.mjs"),
		"--check",
	], { cwd: ROOT });
});

test("generated PKJS detector detects a climb and descent", () => {
	const detector = phoneDetector.createLiftDetector();
	const now = Date.now();
	const events = [];
	for (let second = 0; second <= 30; second++) {
		events.push(...detector.addSample({
			t: now + second * 1000,
			altitude: 2000 + second,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		}));
	}
	for (let second = 0; second <= 6; second++) {
		events.push(...detector.addSample({
			t: now + (31 + second) * 1000,
			altitude: 2030 - second * 2,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		}));
	}

	assert.deepEqual(events.map(event => event.type), ["start", "end"]);
	assert.ok(events[1].lift.gain >= 10);
});
