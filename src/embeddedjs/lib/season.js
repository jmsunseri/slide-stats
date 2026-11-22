/**
 * Date keys, ski seasons, and trip grouping. Pure functions, no Pebble APIs.
 *
 * A season is a 12-month window identified by its start year. The northern
 * preset starts on 1 September, the southern preset on 1 March, and custom uses
 * the configured month/day. "none" treats everything as one all-time bucket.
 */

export const NORTH = { mode: "north", month: 9, day: 1 };
export const SOUTH = { mode: "south", month: 3, day: 1 };

export function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

export function dayKey(date) {
	return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

export function dateFromKey(key) {
	const parts = key.split("-");
	return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** Days since the UTC epoch, used only for calendar-day differences. */
export function dayNumber(key) {
	const parts = key.split("-");
	return Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000);
}

export function seasonStart(settings = {}) {
	const mode = settings.seasonMode || "north";
	if (mode === "south")
		return { month: 3, day: 1 };
	if (mode === "custom")
		return { month: settings.seasonStartMonth || 9, day: settings.seasonStartDay || 1 };
	return { month: 9, day: 1 };
}

export function seasonStartYear(key, settings = {}) {
	const mode = settings.seasonMode || "north";
	if (mode === "none")
		return null;
	const date = dateFromKey(key);
	const start = seasonStart(settings);
	const thisYear = new Date(date.getFullYear(), start.month - 1, start.day);
	return date >= thisYear ? date.getFullYear() : date.getFullYear() - 1;
}

export function seasonKey(key, settings = {}) {
	const startYear = seasonStartYear(key, settings);
	return startYear === null ? "all" : String(startYear);
}

export function seasonLabel(key) {
	if (key === "all" || key === null || key === undefined)
		return "All time";
	const startYear = Number(key);
	if (!isFinite(startYear))
		return "All time";
	return startYear + "-" + pad2((startYear + 1) % 100);
}

export function currentSeasonKey(now, settings = {}) {
	return seasonKey(dayKey(now), settings);
}

export function totalsFor(keys, days) {
	let vertical = 0;
	let runs = 0;
	let best = null;
	for (const key of keys) {
		const day = days[key];
		if (!day)
			continue;
		vertical += day.v || 0;
		runs += day.r || 0;
		if (!best || (day.v || 0) > (best.v || 0))
			best = { date: key, v: day.v || 0, r: day.r || 0 };
	}
	const daysCount = keys.filter(key => days[key]).length;
	return {
		daysCount,
		vertical,
		runs,
		averageVertical: daysCount ? Math.round(vertical / daysCount) : 0,
		averageRuns: daysCount ? Math.round((runs / daysCount) * 10) / 10 : 0,
		bestDay: best,
	};
}

/**
 * Group ride days into trips. A gap of two or fewer rest days links two days:
 * Friday and Monday are the same trip (two days in between), Friday and Tuesday
 * are not.
 */
export function groupTrips(keys, days, gap = 2) {
	const sorted = keys.slice().sort();
	const trips = [];
	let current = null;
	for (const key of sorted) {
		if (!days[key])
			continue;
		const number = dayNumber(key);
		if (!current || number - current.lastNumber > gap + 1) {
			current = { start: key, end: key, lastNumber: number, days: [] };
			trips.push(current);
		}
		current.end = key;
		current.lastNumber = number;
		current.days.push(key);
	}

	return trips.map(trip => {
		const totals = totalsFor(trip.days, days);
		return {
			start: trip.start,
			end: trip.end,
			days: trip.days,
			daysCount: totals.daysCount,
			vertical: totals.vertical,
			runs: totals.runs,
			averageVertical: totals.averageVertical,
			averageRuns: totals.averageRuns,
			bestDay: totals.bestDay,
		};
	});
}

export function summarize(days, settings, now) {
	const currentKey = currentSeasonKey(now, settings);
	const keys = Object.keys(days).filter(key => seasonKey(key, settings) === currentKey);
	const totals = totalsFor(keys, days);
	const trips = groupTrips(keys, days, 2);
	return {
		seasonKey: currentKey,
		label: seasonLabel(currentKey, settings),
		days: totals.daysCount,
		vertical: totals.vertical,
		runs: totals.runs,
		averageVertical: totals.averageVertical,
		averageRuns: totals.averageRuns,
		bestDay: totals.bestDay,
		trips,
	};
}
