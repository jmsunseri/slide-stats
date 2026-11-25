/*
 * Phone-authoritative lift store.
 *
 * This is the phone-side counterpart of the watch's old day store. The phone
 * owns the lifts and computes the compact state that the watch displays. The
 * map shape is the same `YYYY-MM-DD` -> lift records format that the existing
 * `ss.lifts` key already used, so upgrades keep their history.
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

	function read() {
		if (!storage)
			return {};
		let raw;
		try {
			raw = storage.getItem(key);
		}
		catch (error) {
			console.log("phone-store: load failed " + error);
			return {};
		}
		if (typeof raw !== "string" || !raw)
			return {};
		try {
			return JSON.parse(raw) || {};
		}
		catch (error) {
			console.log("phone-store: corrupt store; preserving a copy");
			try {
				if (storage.setItem)
					storage.setItem(key + ".corrupt", raw);
			}
			catch (backupError) {
				console.log("phone-store: backup failed " + backupError);
			}
			return {};
		}
	}

	function write(lifts) {
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
		const lifts = read();
		const date = stats.dayKey(new Date(lift.endTime || lift.startTime));
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
		list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
		lifts[date] = list;
		write(lifts);
		return record;
	}

	function undoLastLift(date) {
		const lifts = read();
		const list = lifts[date];
		if (!list || !list.length)
			return null;
		const lift = list.pop();
		if (!list.length)
			delete lifts[date];
		write(lifts);
		return lift;
	}

	function getLifts() {
		return read();
	}

	function state(settings, at) {
		settings = settings || {};
		const lifts = read();
		const timestamp = at || new Date();
		const todayKey = stats.dayKey(timestamp);
		const today = stats.daySummary(lifts, todayKey);
		const seasonKey = stats.seasonKey(todayKey, settings || {});
		const season = stats.seasonSummary(lifts, settings || {}, seasonKey, timestamp);
		return {
			v: 1,
			generatedAt: timestamp.getTime(),
			today: {
				date: today.date,
				vertical: today.vertical,
				runs: today.runs,
				first: today.first,
				last: today.last,
				longest: today.longest,
				average: today.average,
				older: today.older,
				newer: today.newer,
			},
			season: {
				key: season.key,
				label: season.label,
				days: season.days,
				vertical: season.vertical,
				runs: season.runs,
				averageVertical: season.averageVertical,
				bestDay: season.bestDay,
				older: season.older,
				newer: season.newer,
			},
			settings: {
				units: settings.units === "imperial" ? "imperial" : "metric",
				vibration: settings.vibration !== false,
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
