/*
 * PebbleKit JS: durable lift storage on the phone and the local Clay page.
 *
 * The watch sends one lift record at a time and waits for an Ack. The phone
 * dedupes by date + seq, so retries are harmless.
 */

const Clay = require("@rebble/clay");
const moddableProxy = require("@moddable/pebbleproxy");
const stats = require("./lib/stats");
const { buildConfig, buildPurgeMap } = require("./lib/clay-config");
const { deleteDays } = require("./lib/purge");
const { tabsComponent, clayTabsCustomFn } = require("./lib/clay-tabs");
const { DEFAULT_SETTINGS, flattenSettings, applyClaySettings } = require("./lib/settings");

const LIFTS_KEY = "ss.lifts";
const SETTINGS_KEY = "ss.settings";

// Register every standard component the real page can use, including the
// checkboxgroup used by the data-management tools.
const REGISTRATION_CONFIG = [
	{ type: "heading", defaultValue: "" },
	{ type: "text", defaultValue: "" },
	{ type: "tabs", id: "page-tabs", defaultValue: "settings", options: [] },
	{ type: "select", options: [] },
	{ type: "toggle" },
	{ type: "color" },
	{ type: "slider", min: 0, max: 1, step: 1 },
	{ type: "checkboxgroup", options: [] },
	{ type: "submit", defaultValue: "" },
];
const clay = new Clay(REGISTRATION_CONFIG, clayTabsCustomFn, { autoHandleEvents: false });
clay.registerComponent(tabsComponent);
let purgeSnapshot = {};

function ensureClayMeta() {
	try {
		if (typeof Pebble.getActiveWatchInfo === "function") {
			const info = Pebble.getActiveWatchInfo();
			if (info)
				clay.meta.activeWatchInfo = info;
		}
	}
	catch (error) {
		console.log("slide-stats: watch info unavailable: " + error);
	}
	// Both targets are colour watches. This keeps the 64-colour picker when
	// the phone cannot report the active watch.
	if (!clay.meta.activeWatchInfo)
		clay.meta.activeWatchInfo = { platform: "emery", firmware: { major: 3, minor: 0 } };
}

function loadJson(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	}
	catch (error) {
		console.log("slide-stats: bad storage " + key + ": " + error);
		return fallback;
	}
}

function saveJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	}
	catch (error) {
		console.log("slide-stats: save failed " + key + ": " + error);
	}
}

function loadLifts() {
	return loadJson(LIFTS_KEY, {});
}

function saveLifts(lifts) {
	saveJson(LIFTS_KEY, lifts);
}

function loadSettings() {
	return loadJson(SETTINGS_KEY, null);
}

function saveSettings(settings) {
	saveJson(SETTINGS_KEY, settings);
}

function validPoints(points) {
	return Array.isArray(points) && points.length === 4 &&
		points.every(value => typeof value === "number" && isFinite(value));
}

function cleanLift(record) {
	const lift = {
		seq: record.seq,
		uid: record.uid,
		startTime: record.startTime,
		endTime: record.endTime,
		startAltitude: record.startAltitude,
		peakAltitude: record.peakAltitude,
		gain: record.gain,
		durationMs: record.durationMs,
		incomplete: !!record.incomplete,
	};
	if (validPoints(record.pts))
		lift.pts = record.pts.slice();
	return lift;
}

function handleSync(raw) {
	let record;
	try {
		record = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad sync record: " + error);
		return;
	}
	if (!record || !record.date || !record.id)
		return;

	const lifts = loadLifts();
	const list = lifts[record.date] || [];

	if (record.kind === "lift-delete") {
		const remaining = list.filter(item => record.uid ? item.uid !== record.uid : item.seq !== record.seq);
		if (remaining.length)
			lifts[record.date] = remaining;
		else
			delete lifts[record.date];
	}
	else {
		const clean = cleanLift(record);
		const index = list.findIndex(item => record.uid ? item.uid === record.uid : item.seq === record.seq);
		if (index >= 0)
			list[index] = clean;
		else
			list.push(clean);
		list.sort((a, b) => a.seq - b.seq);
		lifts[record.date] = list;
	}

	saveLifts(lifts);
	console.log("slide-stats pkjs: " + record.kind + " " + record.date + ":" + record.seq);
	Pebble.sendAppMessage(
		{ Ack: JSON.stringify({ id: record.id }) },
		function () {},
		function (error) { console.log("slide-stats: ack failed: " + JSON.stringify(error)); }
	);
}

function handleQuery(raw) {
	let query;
	try {
		query = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad query: " + error);
		return;
	}
	if (!query || !query.kind || !query.key)
		return;
	const lifts = loadLifts();
	const settings = loadSettings() || DEFAULT_SETTINGS;
	let summary;
	if (query.kind === "day")
		summary = stats.daySummary(lifts, query.key);
	else if (query.kind === "season")
		summary = stats.seasonSummary(lifts, settings, query.key, new Date());
	else
		return;
	Pebble.sendAppMessage(
		{ Data: JSON.stringify({ v: 1, kind: query.kind, key: query.key, summary }) },
		function () {},
		function (error) { console.log("slide-stats: data send failed: " + JSON.stringify(error)); }
	);
}

function handleSettings(raw) {
	try {
		saveSettings(JSON.parse(raw));
	}
	catch (error) {
		console.log("slide-stats: bad settings: " + error);
	}
}

Pebble.addEventListener("ready", function (event) {
	console.log("slide-stats pkjs: ready");
	moddableProxy.readyReceived(event);
	const settings = loadSettings();
	if (settings)
		Pebble.sendAppMessage({ Settings: JSON.stringify(settings) });
});

Pebble.addEventListener("appmessage", function (event) {
	if (moddableProxy.appMessageReceived(event))
		return;
	const payload = event.payload || {};
	if (typeof payload.Sync === "string")
		handleSync(payload.Sync);
	if (typeof payload.Settings === "string")
		handleSettings(payload.Settings);
	if (typeof payload.Query === "string")
		handleQuery(payload.Query);
});

Pebble.addEventListener("showConfiguration", function () {
	const settings = loadSettings() || DEFAULT_SETTINGS;
	const lifts = loadLifts();
	const now = new Date();
	const summary = stats.summarize(lifts, settings, now);
	purgeSnapshot = buildPurgeMap(lifts, settings, now);
	clay.config = buildConfig(summary, settings, lifts, purgeSnapshot);
	clay.setSettings(flattenSettings(settings));
	ensureClayMeta();
	Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (event) {
	if (!event || !event.response)
		return;
	let raw;
	try {
		raw = clay.getSettings(event.response, false);
	}
	catch (error) {
		console.log("slide-stats: bad config response: " + error);
		return;
	}
	const values = {};
	for (const key of Object.keys(raw)) {
		const value = raw[key];
		values[key] = value && typeof value === "object" && "value" in value ? value.value : value;
	}
	const settings = applyClaySettings(values, loadSettings() || DEFAULT_SETTINGS);
	const lifts = loadLifts();
	const deleted = deleteDays(lifts, values, purgeSnapshot, stats.dayKey(new Date()));
	if (deleted.removed)
		saveLifts(lifts);
	saveSettings(settings);
	for (const date of deleted.deletedToday) {
		Pebble.sendAppMessage(
			{ Purge: JSON.stringify({ date }) },
			function () {},
			function (error) { console.log("slide-stats: purge send failed: " + JSON.stringify(error)); }
		);
	}
	Pebble.sendAppMessage({ Settings: JSON.stringify(settings) });
	purgeSnapshot = {};
});
