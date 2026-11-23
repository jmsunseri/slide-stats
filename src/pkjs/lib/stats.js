/*
 * Phone-side aggregation. Plain CommonJS because PebbleKit JS is bundled by
 * the Pebble tool, and Node tests load it with require().
 *
 * Input is `lifts`, a map of `YYYY-MM-DD` to lift records synced from the
 * watch. Output is everything the phone page needs: today, season, trips, and
 * an all-time summary.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

function dayKey(date) {
	return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function parseKey(key) {
	const parts = key.split("-");
	return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function dayNumber(key) {
	const parts = key.split("-");
	return Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000);
}

function seasonStart(settings) {
	return (settings.seasonMode || "north") === "south" ? { month: 3, day: 1 } : { month: 9, day: 1 };
}

function seasonKey(key, settings) {
	const date = parseKey(key);
	const start = seasonStart(settings);
	const thisYear = new Date(date.getFullYear(), start.month - 1, start.day);
	const startYear = date >= thisYear ? date.getFullYear() : date.getFullYear() - 1;
	return String(startYear);
}

function seasonLabel(key) {
	if (key === "all")
		return "All time";
	const startYear = Number(key);
	if (!isFinite(startYear))
		return "All time";
	return startYear + "-" + pad2((startYear + 1) % 100);
}

function formatDateShort(key) {
	const date = parseKey(key);
	return MONTHS[date.getMonth()] + " " + pad2(date.getDate());
}

function aggregateLifts(lifts) {
	const days = {};
	for (const key of Object.keys(lifts || {})) {
		const seen = {};
		const list = (lifts[key] || []).filter(lift => {
			if (!lift || !isFinite(lift.gain) || lift.gain <= 0)
				return false;
			const id = lift.uid ? "u:" + lift.uid : "s:" + lift.seq;
			if (seen[id])
				return false;
			seen[id] = true;
			return true;
		});
		if (!list.length)
			continue;
		list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
		let vertical = 0;
		let first = null;
		let last = null;
		let longest = 0;
		for (const lift of list) {
			vertical += Math.round(lift.gain);
			longest = Math.max(longest, Math.round(lift.gain));
			first = first === null ? lift.startTime : Math.min(first, lift.startTime);
			last = last === null ? lift.endTime : Math.max(last, lift.endTime);
		}
		days[key] = {
			date: key,
			v: vertical,
			r: list.length,
			first,
			last,
			longest,
			lifts: list.slice(),
		};
	}
	return days;
}

function totalsFor(keys, days) {
	let vertical = 0;
	let runs = 0;
	let best = null;
	let daysCount = 0;
	for (const key of keys) {
		const day = days[key];
		if (!day)
			continue;
		daysCount++;
		vertical += day.v;
		runs += day.r;
		if (!best || day.v > best.v)
			best = { date: key, v: day.v, r: day.r };
	}
	return {
		daysCount,
		vertical,
		runs,
		averageVertical: daysCount ? Math.round(vertical / daysCount) : 0,
		averageRuns: daysCount ? Math.round((runs / daysCount) * 10) / 10 : 0,
		bestDay: best,
	};
}

function groupTrips(keys, days, gap = 2) {
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
			label: trip.start === trip.end
				? formatDateShort(trip.start)
				: formatDateShort(trip.start) + " - " + formatDateShort(trip.end),
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

function adjacent(keys, key) {
	const sorted = keys.slice().sort();
	let older = null;
	let newer = null;
	for (const item of sorted) {
		if (item < key)
			older = item;
		else if (item > key && newer === null)
			newer = item;
	}
	return { older, newer };
}

function daySummary(lifts, key) {
	const days = aggregateLifts(lifts);
	const day = days[key];
	const edges = adjacent(Object.keys(days), key);
	return {
		date: key,
		vertical: day ? day.v : 0,
		runs: day ? day.r : 0,
		first: day ? day.first : null,
		last: day ? day.last : null,
		longest: day ? day.longest : 0,
		average: day && day.r ? Math.round(day.v / day.r) : 0,
		older: edges.older,
		newer: edges.newer,
	};
}

function seasonKeysFor(lifts, settings, now) {
	const days = aggregateLifts(lifts);
	const keys = {};
	keys[seasonKey(dayKey(now || new Date()), settings)] = true;
	for (const day of Object.keys(days))
		keys[seasonKey(day, settings)] = true;
	return Object.keys(keys).sort().reverse();
}

function seasonSummary(lifts, settings, key, now) {
	const days = aggregateLifts(lifts);
	const keys = Object.keys(days).filter(day => seasonKey(day, settings) === key);
	const totals = totalsFor(keys, days);
	const allSeasons = seasonKeysFor(lifts, settings, now);
	const edges = adjacent(allSeasons, key);
	return {
		key,
		label: seasonLabel(key),
		days: totals.daysCount,
		vertical: totals.vertical,
		runs: totals.runs,
		averageVertical: totals.averageVertical,
		bestDay: totals.bestDay,
		older: edges.older,
		newer: edges.newer,
	};
}

function summarize(lifts, settings, now) {
	settings = settings || {};
	const days = aggregateLifts(lifts);
	const todayKey = dayKey(now || new Date());
	const today = days[todayKey] || {
		date: todayKey, v: 0, r: 0, first: null, last: null, longest: 0, lifts: [],
	};
	const currentKey = seasonKey(todayKey, settings);
	const seasonKeys = Object.keys(days).filter(key => seasonKey(key, settings) === currentKey).sort();
	const seasonTotals = totalsFor(seasonKeys, days);
	const allKeys = Object.keys(days).sort();
	const allTotals = totalsFor(allKeys, days);

	const seasons = {};
	for (const key of allKeys) {
		const season = seasonKey(key, settings);
		if (!seasons[season])
			seasons[season] = { key: season, label: seasonLabel(season), days: 0, vertical: 0, runs: 0 };
		seasons[season].days++;
		seasons[season].vertical += days[key].v;
		seasons[season].runs += days[key].r;
	}

	return {
		generatedAt: (now || new Date()).getTime(),
		today: Object.assign({}, today, {
			average: today.r ? Math.round(today.v / today.r) : 0,
		}),
		days: seasonKeys.slice().reverse().map(key => days[key]),
		season: Object.assign({
			key: currentKey,
			label: seasonLabel(currentKey),
			trips: groupTrips(seasonKeys, days, 2),
			series: seasonKeys.map(key => ({ date: key, vertical: days[key].v })),
		}, seasonTotals),
		allTime: Object.assign({
			key: "all",
			label: "All time",
			seasons: Object.keys(seasons).sort().reverse().map(key => seasons[key]),
		}, allTotals),
	};
}

module.exports = {
	summarize,
	daySummary,
	seasonSummary,
	seasonKeysFor,
	aggregateLifts,
	totalsFor,
	groupTrips,
	seasonKey,
	seasonLabel,
	dayKey,
	formatDateShort,
};
