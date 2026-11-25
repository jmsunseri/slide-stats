/**
 * Date keys, ski seasons, and display formatting.
 *
 * Pure functions with no Pebble or storage APIs, shared by the watch display
 * and the Node tests. Altitudes are stored in metres; only presentation
 * changes.
 */

/* ------------------------------------------------------------------ */
/* Seasons and trips                                                   */
/* ------------------------------------------------------------------ */

/**
 * Date keys, ski seasons, and trip grouping. Pure functions, no Pebble APIs.
 *
 * A season is a 12-month window identified by its start year. The northern
 * preset starts on 1 September; the southern preset starts on 1 March.
 */

function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

function dayKey(date) {
	return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function dateFromKey(key) {
	const parts = key.split("-");
	return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function seasonStart(settings = {}) {
	return settings.seasonMode === "south" ? { month: 3, day: 1 } : { month: 9, day: 1 };
}

function seasonStartYear(key, settings = {}) {
	const date = dateFromKey(key);
	const start = seasonStart(settings);
	const thisYear = new Date(date.getFullYear(), start.month - 1, start.day);
	return date >= thisYear ? date.getFullYear() : date.getFullYear() - 1;
}

function seasonKey(key, settings = {}) {
	return String(seasonStartYear(key, settings));
}

function seasonLabel(key) {
	if (key === "all" || key === null || key === undefined)
		return "All time";
	const startYear = Number(key);
	if (!isFinite(startYear))
		return "All time";
	return startYear + "-" + pad2((startYear + 1) % 100);
}

function currentSeasonKey(now, settings = {}) {
	return seasonKey(dayKey(now), settings);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Display formatting. Pure functions so the watch and tests agree.
 * Altitudes are stored in metres; only the presentation changes.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const METRES_TO_FEET = 3.28084;


function groupThousands(value) {
	const rounded = Math.round(value);
	const negative = rounded < 0;
	const digits = String(Math.abs(rounded));
	let result = "";
	for (let i = 0; i < digits.length; i++) {
		if (i && ((digits.length - i) % 3) === 0)
			result += ",";
		result += digits[i];
	}
	return negative ? "-" + result : result;
}

function toFeet(metres) {
	return metres * METRES_TO_FEET;
}


function unitLabel(units, short) {
	if (units === "imperial")
		return short ? "ft" : "feet";
	return short ? "m" : "metres";
}


function formatVertical(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? toFeet(metres) : metres;
	return groupThousands(value) + " " + unitLabel(units, true);
}

function formatClock(date, hour12) {
	let hours = date.getHours();
	let suffix = "";
	if (hour12) {
		suffix = hours >= 12 ? "PM" : "AM";
		hours = hours % 12;
		if (hours === 0)
			hours = 12;
	}
	return {
		text: (hour12 ? String(hours) : pad2(hours)) + ":" + pad2(date.getMinutes()),
		suffix,
	};
}

/** Compact clock for the hero label: "10:42" or "10:42p". */
function formatTime(date, hour12) {
	const clock = formatClock(date, hour12);
	return clock.suffix ? clock.text + clock.suffix[0].toLowerCase() : clock.text;
}

function formatDateShort(key) {
	const parts = key.split("-");
	const month = Number(parts[1]);
	const day = Number(parts[2]);
	return MONTHS[month - 1] + " " + (day < 10 ? "0" + day : day);
}

function formatAverage(value, units) {
	if (!isFinite(value))
		return "--";
	return groupThousands(units === "imperial" ? toFeet(value) : value) + " " + unitLabel(units, true);
}

export {
	MONTHS,
	METRES_TO_FEET,
	dayKey,
	dateFromKey,
	seasonStart,
	seasonStartYear,
	seasonKey,
	seasonLabel,
	currentSeasonKey,
	pad2,
	groupThousands,
	toFeet,
	unitLabel,
	formatVertical,
	formatClock,
	formatTime,
	formatDateShort,
	formatAverage,
};
