import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stats = require("../src/pkjs/lib/stats.js");
const dashboard = require("../src/pkjs/lib/dashboard.js");

const NOW = new Date(2026, 2, 14, 12, 0);

function settings(theme) {
	return {
		units: "metric",
		vibration: true,
		paused: false,
		sampleIntervalMs: 10000,
		seasonMode: "north",
		trips: true,
		theme,
		detection: {
			fastGainM: 10, fastWindowMs: 30000,
			slowGainM: 10, slowWindowMs: 90000,
			minLiftGainM: 10, endDescentM: 5, maxSpeedMps: 8,
		},
	};
}

function render(theme) {
	const lifts = {
		"2026-03-14": [{
			seq: 1,
			startTime: new Date(2026, 2, 14, 9, 0).getTime(),
			endTime: new Date(2026, 2, 14, 9, 5).getTime(),
			gain: 400,
		}],
	};
	const s = settings(theme);
	return dashboard.render({ summary: stats.summarize(lifts, s, NOW), settings: s });
}

function embeddedSettings(html) {
	const match = html.match(/<script type="application\/json" id="settings-data">([\s\S]*?)<\/script>/);
	return JSON.parse(match[1]);
}

test("dashboard settings expose three native colour inputs", () => {
	const html = render({ background: 0x0055aa, accent: 0xffaa00, text: 0xffffff });
	assert.ok(html.includes('id="themeBackground"'));
	assert.ok(html.includes('id="themeAccent"'));
	assert.ok(html.includes('id="themeText"'));
	assert.ok(html.includes('value="#0055aa"'));
	assert.ok(html.includes('value="#ffaa00"'));
	assert.ok(html.includes('value="#ffffff"'));
	assert.ok(html.includes("snapColor"));
	assert.ok(html.includes("packColor"));
	assert.equal(embeddedSettings(html).theme.accent, 0xffaa00);
});

test("dashboard renders legacy hex theme values", () => {
	const html = render({ background: "#0055aa", accent: "#ffaa00", text: "#ffffff" });
	assert.ok(html.includes('value="#0055aa"'));
	assert.ok(html.includes('value="#ffaa00"'));
	assert.ok(html.includes('value="#ffffff"'));
});

test("dashboard falls back to the default theme", () => {
	const html = render(undefined);
	assert.ok(html.includes('id="themeBackground" value="#ffffff"'));
	assert.ok(html.includes('id="themeAccent" value="#000000"'));
	assert.ok(html.includes('id="themeText" value="#000000"'));
});
