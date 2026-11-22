/*
 * PebbleKit JS: durable lift storage on the phone and the local stats page.
 *
 * The watch sends one lift record at a time and waits for an Ack. The phone
 * dedupes by date + seq, so retries are harmless.
 */

const moddableProxy = require("@moddable/pebbleproxy");
const stats = require("./lib/stats");
const dashboard = require("./lib/dashboard");

const LIFTS_KEY = "ss.lifts";
const SETTINGS_KEY = "ss.settings";

const DEFAULT_SETTINGS = {
	units: "metric",
	vibration: true,
	paused: false,
	sampleIntervalMs: 10000,
	seasonMode: "north",
	seasonStartMonth: 9,
	seasonStartDay: 1,
	trips: true,
	detection: {
		fastGainM: 10,
		fastWindowMs: 30000,
		slowGainM: 10,
		slowWindowMs: 90000,
		minLiftGainM: 10,
		endDescentM: 5,
		maxSpeedMps: 8,
	},
};

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

function cleanLift(record) {
	return {
		seq: record.seq,
		startTime: record.startTime,
		endTime: record.endTime,
		startAltitude: record.startAltitude,
		peakAltitude: record.peakAltitude,
		gain: record.gain,
		durationMs: record.durationMs,
		incomplete: !!record.incomplete,
	};
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
		const remaining = list.filter(item => item.seq !== record.seq);
		if (remaining.length)
			lifts[record.date] = remaining;
		else
			delete lifts[record.date];
	}
	else {
		const clean = cleanLift(record);
		const index = list.findIndex(item => item.seq === record.seq);
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
});

Pebble.addEventListener("showConfiguration", function () {
	const settings = loadSettings() || DEFAULT_SETTINGS;
	const summary = stats.summarize(loadLifts(), settings, new Date());
	const html = dashboard.render({ summary: summary, settings: settings });
	Pebble.openURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
});

Pebble.addEventListener("webviewclosed", function (event) {
	if (!event.response)
		return;
	let settings;
	try {
		settings = JSON.parse(event.response);
	}
	catch (error) {
		try {
			settings = JSON.parse(decodeURIComponent(event.response));
		}
		catch (second) {
			console.log("slide-stats: bad config response: " + second);
			return;
		}
	}
	saveSettings(settings);
	Pebble.sendAppMessage({ Settings: JSON.stringify(settings) });
});
