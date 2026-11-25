/*
 * Phone-side settings defaults and the mapping between the nested settings
 * blob shared with the watch and the flat values used by the Clay form.
 */

const DEFAULT_SETTINGS = {
	units: "metric",
	vibration: true,
	paused: false,
	sampleIntervalMs: 10000,
	seasonMode: "north",
	trips: true,
	theme: {
		background: 0xffffff,
		// Pebble's second-darkest blue: GColorDukeBlue (#0000AA).
		accent: 0x0000aa,
		text: 0x000000,
	},
	detection: {
		fastGainM: 10,
		fastWindowMs: 30000,
		slowGainM: 10,
		slowWindowMs: 90000,
		minLiftGainM: 10,
		endDescentM: 5,
	},
};

function numberIn(value, min, max, fallback) {
	const number = typeof value === "number" ? value : parseFloat(value);
	if (!isFinite(number))
		return fallback;
	return Math.min(max, Math.max(min, Math.round(number)));
}

function snapChannel(value) {
	if (value < 43)
		return 0x00;
	if (value < 128)
		return 0x55;
	if (value < 213)
		return 0xAA;
	return 0xFF;
}

function colorIn(value, fallback) {
	let number;
	if (typeof value === "number" && isFinite(value))
		number = value;
	else
		number = parseInt(String(value || "").replace(/^#/, ""), 16);
	if (!isFinite(number))
		return fallback;
	const red = snapChannel((number >> 16) & 0xFF);
	const green = snapChannel((number >> 8) & 0xFF);
	const blue = snapChannel(number & 0xFF);
	return (red << 16) | (green << 8) | blue;
}

function flattenSettings(settings) {
	const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
	const theme = Object.assign({}, DEFAULT_SETTINGS.theme, source.theme || {});
	const detection = Object.assign({}, DEFAULT_SETTINGS.detection, source.detection || {});
	return {
		units: source.units === "imperial" ? "imperial" : "metric",
		vibration: source.vibration !== false,
		trips: source.trips !== false,
		seasonMode: source.seasonMode === "south" ? "south" : "north",
		intervalSec: Math.round((source.sampleIntervalMs || 10000) / 1000),
		minGainM: Math.round(detection.minLiftGainM || 10),
		endDescentM: Math.round(detection.endDescentM || 5),
		fastWindowSec: Math.round((detection.fastWindowMs || 30000) / 1000),
		slowWindowSec: Math.round((detection.slowWindowMs || 90000) / 1000),
		themeBackground: colorIn(theme.background, DEFAULT_SETTINGS.theme.background),
		themeAccent: colorIn(theme.accent, DEFAULT_SETTINGS.theme.accent),
		themeText: colorIn(theme.text, DEFAULT_SETTINGS.theme.text),
	};
}

function applyClaySettings(values, current) {
	values = values || {};
	const source = Object.assign({}, current || DEFAULT_SETTINGS);
	const baseDetection = Object.assign({}, DEFAULT_SETTINGS.detection, source.detection || {});
	const baseTheme = Object.assign({}, DEFAULT_SETTINGS.theme, source.theme || {});
	const detection = Object.assign({}, baseDetection);
	const settings = Object.assign({}, source);

	settings.units = values.units === undefined
		? (source.units === "imperial" ? "imperial" : "metric")
		: (values.units === "imperial" ? "imperial" : "metric");
	settings.vibration = values.vibration === undefined ? source.vibration !== false : !!values.vibration;
	settings.trips = values.trips === undefined ? source.trips !== false : !!values.trips;
	settings.seasonMode = values.seasonMode === undefined
		? (source.seasonMode === "south" ? "south" : "north")
		: (values.seasonMode === "south" ? "south" : "north");
	settings.sampleIntervalMs = numberIn(
		values.intervalSec, 5, 60, Math.round((source.sampleIntervalMs || 10000) / 1000)
	) * 1000;

	detection.minLiftGainM = numberIn(values.minGainM, 5, 50, baseDetection.minLiftGainM || 10);
	detection.endDescentM = numberIn(values.endDescentM, 3, 20, baseDetection.endDescentM || 5);
	detection.fastWindowMs = numberIn(
		values.fastWindowSec, 20, 60, Math.round((baseDetection.fastWindowMs || 30000) / 1000)
	) * 1000;
	detection.slowWindowMs = numberIn(
		values.slowWindowSec, 60, 180, Math.round((baseDetection.slowWindowMs || 90000) / 1000)
	) * 1000;
	delete detection.maxSpeedMps;
	settings.detection = detection;
	settings.theme = {
		background: colorIn(values.themeBackground, baseTheme.background),
		accent: colorIn(values.themeAccent, baseTheme.accent),
		text: colorIn(values.themeText, baseTheme.text),
	};

	delete settings.seasonStartMonth;
	delete settings.seasonStartDay;
	return settings;
}

module.exports = {
	DEFAULT_SETTINGS,
	flattenSettings,
	applyClaySettings,
};
