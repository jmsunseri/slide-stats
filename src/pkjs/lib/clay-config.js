/*
 * Builds the Clay configuration page. Settings come first; the read-only
 * stats below cover today, the current season, and this season's trips.
 */

const stats = require("./stats");
const { flattenSettings } = require("./settings");

function group(value) {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtVertical(metres, units) {
	const value = units === "imperial" ? metres * 3.28084 : metres;
	return group(value) + (units === "imperial" ? " ft" : " m");
}

function plural(count, one, many) {
	return count + " " + (count === 1 ? one : many);
}

function esc(value) {
	return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[character]));
}

function todayText(today, units) {
	if (!today || !today.r)
		return "No lifts yet today.";
	const average = today.v / today.r;
	return "<strong>" + fmtVertical(today.v, units) + "</strong><br>" +
		plural(today.r, "run", "runs") + " · average " + fmtVertical(average, units) +
		" · longest " + fmtVertical(today.longest || 0, units);
}

function seasonText(season, units) {
	if (!season || !season.daysCount)
		return "No ski days yet this season.";
	let text = "<strong>" + fmtVertical(season.vertical, units) + "</strong><br>" +
		plural(season.daysCount, "ski day", "ski days") + " · " +
		plural(season.runs, "run", "runs") + " · average " +
		fmtVertical(season.averageVertical || 0, units) + " / day";
	if (season.bestDay)
		text += "<br>Best day " + stats.formatDateShort(season.bestDay.date) +
			" · " + fmtVertical(season.bestDay.v || 0, units);
	return text;
}

function tripsText(trips, units) {
	if (!trips || !trips.length)
		return "No trips yet this season.";
	return trips.slice().reverse().map(trip =>
		"<strong>" + esc(trip.label) + "</strong> · " +
		fmtVertical(trip.vertical || 0, units) + " · " +
		plural(trip.runs || 0, "run", "runs") + " · " +
		plural(trip.daysCount || 0, "day", "days")
	).join("<br>");
}

function buildConfig(summary, settings) {
	const flat = flattenSettings(settings);
	const units = flat.units;
	const today = summary.today || {};
	const season = summary.season || {};
	const todayLabel = today.date ? "Today · " + stats.formatDateShort(today.date) : "Today";
	const seasonLabel = season.label ? "Season " + season.label : "Season";

	const config = [
		{ type: "heading", defaultValue: "Slide Stats", size: 1 },
		{ type: "text", defaultValue: "Settings and stats stay on this phone." },
		{ type: "heading", defaultValue: "Settings", size: 2 },
		{ type: "section", items: [
			{
				type: "select",
				messageKey: "units",
				label: "Units",
				defaultValue: flat.units,
				options: [
					{ label: "Metric (m, km/h)", value: "metric" },
					{ label: "Imperial (ft, mph)", value: "imperial" },
				],
			},
			{
				type: "toggle",
				messageKey: "vibration",
				label: "Vibrate on lift start and end",
				defaultValue: flat.vibration,
			},
			{
				type: "toggle",
				messageKey: "trips",
				label: "Show trips",
				defaultValue: flat.trips,
			},
			{
				type: "select",
				messageKey: "seasonMode",
				label: "Hemisphere",
				defaultValue: flat.seasonMode,
				options: [
					{ label: "Northern (Sep–Aug)", value: "north" },
					{ label: "Southern (Mar–Feb)", value: "south" },
				],
			},
		] },
		{ type: "heading", defaultValue: "Theme", size: 3 },
		{ type: "section", items: [
			{
				type: "color",
				messageKey: "themeBackground",
				label: "Background",
				defaultValue: flat.themeBackground,
				sunlight: false,
			},
			{
				type: "color",
				messageKey: "themeAccent",
				label: "Accent bar",
				defaultValue: flat.themeAccent,
				sunlight: false,
			},
			{
				type: "color",
				messageKey: "themeText",
				label: "Text and menu",
				defaultValue: flat.themeText,
				sunlight: false,
			},
		] },
		{ type: "text", defaultValue: "Accent colours the right-hand bar; its icons stay white, so pick a dark accent." },
		{ type: "heading", defaultValue: "Lift detection", size: 3 },
		{ type: "section", items: [
			{
				type: "slider",
				messageKey: "intervalSec",
				label: "Altitude interval (seconds)",
				defaultValue: flat.intervalSec,
				min: 5,
				max: 60,
				step: 1,
			},
			{
				type: "slider",
				messageKey: "minGainM",
				label: "Minimum lift gain (m)",
				defaultValue: flat.minGainM,
				min: 5,
				max: 50,
				step: 1,
			},
			{
				type: "slider",
				messageKey: "endDescentM",
				label: "Descent that ends a lift (m)",
				defaultValue: flat.endDescentM,
				min: 3,
				max: 20,
				step: 1,
			},
			{
				type: "slider",
				messageKey: "fastWindowSec",
				label: "Fast window (seconds)",
				defaultValue: flat.fastWindowSec,
				min: 20,
				max: 60,
				step: 5,
			},
			{
				type: "slider",
				messageKey: "slowWindowSec",
				label: "Slow window (seconds)",
				defaultValue: flat.slowWindowSec,
				min: 60,
				max: 180,
				step: 10,
			},
			{
				type: "slider",
				messageKey: "maxSpeedKmh",
				label: "Maximum speed (km/h)",
				defaultValue: flat.maxSpeedKmh,
				min: 0,
				max: 54,
				step: 1,
			},
		] },
		{ type: "text", defaultValue: "Detection thresholds are metric; the units setting changes the stats. Changes affect future lifts, not past ones." },
		{ type: "submit", defaultValue: "Save Settings" },
		{ type: "heading", defaultValue: "Stats", size: 2 },
		{ type: "heading", defaultValue: todayLabel, size: 3 },
		{ type: "text", defaultValue: todayText(today, units) },
		{ type: "heading", defaultValue: seasonLabel, size: 3 },
		{ type: "text", defaultValue: seasonText(season, units) },
	];

	if (flat.trips) {
		config.push(
			{ type: "heading", defaultValue: "Trips this season", size: 3 },
			{ type: "text", defaultValue: tripsText(season.trips, units) }
		);
	}

	config.push(
		{ type: "text", defaultValue: "Stats are stored on this phone. Open Slide Stats on the watch before syncing." }
	);
	return config;
}

module.exports = { buildConfig };
