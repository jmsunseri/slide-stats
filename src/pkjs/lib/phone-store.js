/*
 * Phone-authoritative lift store.
 *
 * This is the phone-side counterpart of the watch's old day store. The phone
 * owns the lifts and computes the compact state that the watch displays. It is
 * deliberately separate from the existing ss.lifts store so the redesign can be
 * tested in shadow mode before the watch gives up ownership.
 */

const stats = require("./stats");

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function makeUid(date, seq, now) {
	return date + ":" + seq + ":" + now().toString(36) +
		Math.random().toString(36).slice(2, 8);
}

function packPoints(lift) {
	const values = [lift.startLat, lift.startLon, lift.peakLat, lift.peakLon];
	if (!values.every(value => typeof value === "number" && isFinite(value)))
		return null;
	return values.map(value => Math.round(value * 1e6));
}

function createPhoneStore(options = {}) {
	const storage = options.storage;
	const key = options.key || "ss.lifts";
	const now = options.now || (() => Date.now());

	let lifts = {};
	try {
		const raw = storage && storage.getItem(key);
		if (raw)
			lifts = JSON.parse(raw) || {};
	}
	catch (error) {
		console.log("phone-store: load failed " + error);
	}

	function save() {
		if (!storage)
			return;
		try {
			storage.setItem(key, JSON.stringify(lifts));
		}
		catch (error) {
			console.log("phone-store: save failed " + error);
		}
	}

	function addLift(lift) {
		const date = stats.dayKey(new Date(lift.startTime));
		const list = lifts[date] || [];
		let seq = 1;
		for (const item of list)
			seq = Math.max(seq, (item.seq || 0) + 1);
		const record = {
			seq,
			uid: makeUid(date, seq, now),
			startTime: lift.startTime,
			endTime: lift.endTime,
			startAltitude: Math.round(lift.startAltitude),
			peakAltitude: Math.round(lift.peakAltitude),
			gain: Math.round(lift.gain),
			durationMs: lift.durationMs,
			incomplete: !!lift.incomplete,
		};
		const pts = packPoints(lift);
		if (pts)
			record.pts = pts;
		list.push(record);
		list.sort((a, b) => a.seq - b.seq);
		lifts[date] = list;
		save();
		return record;
	}

	function undoLastLift(date) {
		const list = lifts[date];
		if (!list || !list.length)
			return null;
		const lift = list.pop();
		if (!list.length)
			delete lifts[date];
		save();
		return lift;
	}

	function getLifts() {
		return clone(lifts);
	}

	function state(settings, at) {
		const summary = stats.summarize(lifts, settings || {}, at || new Date());
		const today = summary.today;
		const season = summary.season;
		return {
			v: 1,
			generatedAt: summary.generatedAt,
			today: {
				date: today.date,
				vertical: today.v,
				runs: today.r,
				first: today.first,
				last: today.last,
				longest: today.longest,
				average: today.average,
			},
			season: {
				key: season.key,
				label: season.label,
				days: season.daysCount,
				vertical: season.vertical,
				runs: season.runs,
				averageVertical: season.averageVertical,
				bestDay: season.bestDay,
			},
			settings: {
				units: settings.units === "imperial" ? "imperial" : "metric",
				vibration: settings.vibration !== false,
				paused: !!settings.paused,
				closed: !!settings.closed,
				seasonMode: settings.seasonMode === "south" ? "south" : "north",
				theme: settings.theme,
			},
		};
	}

	return {
		addLift,
		undoLastLift,
		getLifts,
		state,
	};
}

module.exports = { createPhoneStore };
