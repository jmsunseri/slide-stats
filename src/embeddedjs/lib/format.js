/**
 * Display formatting. Pure functions so the watch and tests agree.
 * Altitudes are stored in metres; only the presentation changes.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const METRES_TO_FEET = 3.28084;

export function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

export function groupThousands(value) {
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

export function toFeet(metres) {
	return metres * METRES_TO_FEET;
}

export function fromFeet(feet) {
	return feet / METRES_TO_FEET;
}

export function unitLabel(units, short) {
	if (units === "imperial")
		return short ? "ft" : "feet";
	return short ? "m" : "metres";
}

export function formatAltitude(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? toFeet(metres) : metres;
	return groupThousands(value) + " " + unitLabel(units, true);
}

export function formatVertical(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? toFeet(metres) : metres;
	const rounded = Math.round(value);
	const sign = rounded > 0 ? "+" : "";
	return sign + groupThousands(rounded) + " " + unitLabel(units, true);
}

export function formatClock(date, hour12) {
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
export function formatTime(date, hour12) {
	const clock = formatClock(date, hour12);
	return clock.suffix ? clock.text + clock.suffix[0].toLowerCase() : clock.text;
}

export function formatDateShort(key) {
	const parts = key.split("-");
	const month = Number(parts[1]);
	const day = Number(parts[2]);
	return MONTHS[month - 1] + " " + day;
}

export function formatDateRange(startKey, endKey) {
	return startKey === endKey
		? formatDateShort(startKey)
		: formatDateShort(startKey) + " - " + formatDateShort(endKey);
}

export function formatDuration(ms) {
	if (!isFinite(ms) || ms <= 0)
		return "0m";
	const totalMinutes = Math.round(ms / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours && minutes)
		return hours + "h " + minutes + "m";
	if (hours)
		return hours + "h";
	return minutes + "m";
}

export function formatAverage(value, units) {
	if (!isFinite(value))
		return "--";
	return groupThousands(units === "imperial" ? toFeet(value) : value) + " " + unitLabel(units, true);
}
