import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stats = require("../src/pkjs/lib/stats.js");
const { buildConfig } = require("../src/pkjs/lib/clay-config.js");
const { DEFAULT_SETTINGS, flattenSettings, applyClaySettings } = require("../src/pkjs/lib/settings.js");

const NOW = new Date(2026, 10, 22, 12, 0);
const START = new Date(2026, 10, 22, 9, 0).getTime();

function lift(seq, startTime, gain) {
	return { seq, uid: "u" + seq, startTime, endTime: startTime + 300000, gain };
}

const LIFTS = {
	"2026-11-22": [lift(1, START, 410), lift(2, START + 3600000, 380)],
	"2026-11-21": [
		lift(1, START - 86400000, 520),
		lift(2, START - 86400000 + 3600000, 460),
		lift(3, START - 86400000 + 7200000, 495),
	],
	"2026-11-15": [lift(1, START - 7 * 86400000, 610)],
};

function summary() {
	return stats.summarize(LIFTS, DEFAULT_SETTINGS, NOW);
}

function items(config) {
	return config.flatMap(item => (item.type === "section" ? item.items : [item]));
}

function byKey(config, key) {
	return items(config).find(item => item.messageKey === key);
}

function texts(config) {
	return items(config)
		.filter(item => item.type === "text")
		.map(item => item.defaultValue)
		.join("\n");
}

test("Clay config puts every setting before the stats", () => {
	const config = buildConfig(summary(), DEFAULT_SETTINGS);
	const settings = config.findIndex(item => item.type === "heading" && item.defaultValue === "Settings");
	const submit = config.findIndex(item => item.type === "submit");
	const statsHeading = config.findIndex(item => item.type === "heading" && item.defaultValue === "Stats");
	assert.ok(settings >= 0);
	assert.ok(submit > settings);
	assert.ok(statsHeading > submit);

	assert.equal(byKey(config, "units").defaultValue, "metric");
	assert.equal(byKey(config, "vibration").defaultValue, true);
	assert.equal(byKey(config, "trips").defaultValue, true);
	assert.equal(byKey(config, "seasonMode").defaultValue, "north");
	assert.equal(byKey(config, "intervalSec").defaultValue, 10);
	assert.equal(byKey(config, "minGainM").defaultValue, 10);
	assert.equal(byKey(config, "endDescentM").defaultValue, 5);
	assert.equal(byKey(config, "fastWindowSec").defaultValue, 30);
	assert.equal(byKey(config, "slowWindowSec").defaultValue, 90);
	assert.equal(byKey(config, "maxSpeedKmh").defaultValue, 29);

	const colors = items(config).filter(item => item.type === "color");
	assert.deepEqual(colors.map(item => item.messageKey), ["themeBackground", "themeAccent", "themeText"]);
	assert.deepEqual(colors.map(item => item.defaultValue), [0xffffff, 0x000000, 0x000000]);
	assert.ok(colors.every(item => item.sunlight === false));
});

test("Clay stats show today and the current season", () => {
	const config = buildConfig(summary(), DEFAULT_SETTINGS);
	const text = texts(config);
	assert.ok(text.includes("<strong>790 m</strong>"));
	assert.ok(text.includes("2 runs · average 395 m · longest 410 m"));
	assert.ok(text.includes("<strong>2,875 m</strong>"));
	assert.ok(text.includes("3 ski days · 6 runs · average 958 m / day"));
	const headings = items(config)
		.filter(item => item.type === "heading")
		.map(item => item.defaultValue);
	assert.ok(headings.includes("Season 2026-27"));
	assert.ok(!text.includes("<table"));
	assert.ok(!text.includes("<svg"));
});

test("Clay stats use imperial units for the current season and trips", () => {
	const imperial = Object.assign({}, DEFAULT_SETTINGS, { units: "imperial" });
	const config = buildConfig(summary(), imperial);
	const text = texts(config);
	assert.ok(text.includes("<strong>2,592 ft</strong>"));
	assert.ok(text.includes("<strong>9,432 ft</strong>"));
	assert.ok(text.includes("<strong>Nov 21 - Nov 22</strong>"));
	assert.ok(!text.includes("1,475 m"));
	assert.ok(text.includes("4,839 ft"));
});

test("Clay omits the trips section when trips are turned off", () => {
	const hidden = Object.assign({}, DEFAULT_SETTINGS, { trips: false });
	const config = buildConfig(summary(), hidden);
	const headings = items(config)
		.filter(item => item.type === "heading")
		.map(item => item.defaultValue);
	assert.ok(!headings.includes("Trips this season"));
	assert.ok(byKey(config, "trips"));
});

test("flattenSettings maps nested settings to Clay values", () => {
	const custom = Object.assign({}, DEFAULT_SETTINGS, {
		units: "imperial",
		vibration: false,
		trips: false,
		seasonMode: "south",
		sampleIntervalMs: 30000,
		theme: { background: "#123456", accent: 0xffaa00, text: 0xffffff },
		detection: Object.assign({}, DEFAULT_SETTINGS.detection, {
			minLiftGainM: 16,
			endDescentM: 10,
			fastWindowMs: 45000,
			slowWindowMs: 120000,
			maxSpeedMps: 10,
		}),
	});
	const flat = flattenSettings(custom);
	assert.equal(flat.units, "imperial");
	assert.equal(flat.vibration, false);
	assert.equal(flat.trips, false);
	assert.equal(flat.seasonMode, "south");
	assert.equal(flat.intervalSec, 30);
	assert.equal(flat.minGainM, 16);
	assert.equal(flat.endDescentM, 10);
	assert.equal(flat.fastWindowSec, 45);
	assert.equal(flat.slowWindowSec, 120);
	assert.equal(flat.maxSpeedKmh, 36);
	assert.equal(flat.themeBackground, 0x005555);
	assert.equal(flat.themeAccent, 0xffaa00);
	assert.equal(flat.themeText, 0xffffff);
});

test("applyClaySettings rebuilds the nested settings and converts units", () => {
	const current = Object.assign({}, DEFAULT_SETTINGS, {
		paused: true,
		detection: Object.assign({}, DEFAULT_SETTINGS.detection, {
			fastGainM: 12,
			slowGainM: 9,
		}),
	});
	const settings = applyClaySettings({
		units: "imperial",
		vibration: false,
		trips: false,
		seasonMode: "south",
		intervalSec: "30",
		minGainM: "16",
		endDescentM: "10",
		fastWindowSec: "30",
		slowWindowSec: "90",
		maxSpeedKmh: "34",
		themeBackground: 0x0055aa,
		themeAccent: 0xffaa00,
		themeText: 0xffffff,
	}, current);
	assert.equal(settings.units, "imperial");
	assert.equal(settings.vibration, false);
	assert.equal(settings.trips, false);
	assert.equal(settings.seasonMode, "south");
	assert.equal(settings.sampleIntervalMs, 30000);
	assert.equal(settings.detection.minLiftGainM, 16);
	assert.equal(settings.detection.endDescentM, 10);
	assert.equal(settings.detection.fastWindowMs, 30000);
	assert.equal(settings.detection.slowWindowMs, 90000);
	assert.equal(settings.detection.maxSpeedMps, 9);
	assert.equal(settings.detection.fastGainM, 12);
	assert.equal(settings.detection.slowGainM, 9);
	assert.equal(settings.paused, true);
	assert.equal(settings.theme.background, 0x0055aa);
	assert.equal(settings.theme.accent, 0xffaa00);
	assert.equal(settings.theme.text, 0xffffff);
});

test("applyClaySettings clamps bad values and preserves missing ones", () => {
	const clamped = applyClaySettings({
		intervalSec: 1,
		minGainM: 0,
		endDescentM: 100,
		fastWindowSec: 1,
		slowWindowSec: 999,
		maxSpeedKmh: 999,
		themeBackground: "not-a-colour",
	}, DEFAULT_SETTINGS);
	assert.equal(clamped.sampleIntervalMs, 5000);
	assert.equal(clamped.detection.minLiftGainM, 5);
	assert.equal(clamped.detection.endDescentM, 20);
	assert.equal(clamped.detection.fastWindowMs, 20000);
	assert.equal(clamped.detection.slowWindowMs, 180000);
	assert.equal(clamped.detection.maxSpeedMps, 15);
	assert.equal(clamped.theme.background, DEFAULT_SETTINGS.theme.background);

	const preserved = applyClaySettings({}, {
		units: "imperial",
		paused: true,
		sampleIntervalMs: 20000,
		seasonMode: "south",
		theme: { background: 0x0055aa, accent: 0xffaa00, text: 0xffffff },
		detection: Object.assign({}, DEFAULT_SETTINGS.detection, { fastGainM: 12 }),
	});
	assert.equal(preserved.units, "imperial");
	assert.equal(preserved.paused, true);
	assert.equal(preserved.sampleIntervalMs, 20000);
	assert.equal(preserved.seasonMode, "south");
	assert.equal(preserved.theme.background, 0x0055aa);
	assert.equal(preserved.detection.fastGainM, 12);
});
