/**
 * Persistent day/session state.
 *
 * One JSON blob in localStorage keeps flash writes to a minimum: settings,
 * per-day aggregates, today's lifts, the sync outbox, and the lift sequence.
 * The storage adapter is injected so tests can run headlessly.
 */

import { dayKey, summarize } from "./season.js";

const STATE_KEY = "ss.state";
const STATE_VERSION = 1;

export const DEFAULT_SETTINGS = {
	units: "metric",
	vibration: true,
	paused: false,
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, patch) {
	const result = Object.assign({}, base, patch);
	result.detection = Object.assign({}, base.detection, patch && patch.detection);
	return result;
}

function emptyDay(key, base, baseTime) {
	return {
		date: key,
		base: base === undefined ? null : base,
		baseTime: baseTime === undefined ? null : baseTime,
		closed: false,
		lifts: [],
	};
}

export function createDayStore(options = {}) {
	const storage = options.storage;
	const now = options.now || (() => Date.now());

	let settings = clone(DEFAULT_SETTINGS);
	let days = {};
	let today = null;
	let outbox = [];
	let nextSeq = 1;

	function save() {
		if (!storage)
			return;
		try {
			storage.setItem(STATE_KEY, JSON.stringify({
				v: STATE_VERSION,
				settings,
				days,
				today,
				outbox,
				nextSeq,
			}));
		}
		catch (error) {
			console.log("slide-stats: save failed: " + error);
		}
	}

	function load() {
		let stored = null;
		try {
			const raw = storage && storage.getItem(STATE_KEY);
			if (raw)
				stored = JSON.parse(raw);
		}
		catch (error) {
			console.log("slide-stats: load failed: " + error);
		}

		if (stored) {
			settings = mergeSettings(DEFAULT_SETTINGS, stored.settings || {});
			days = stored.days || {};
			today = stored.today || null;
			outbox = stored.outbox || [];
			nextSeq = stored.nextSeq || 1;
		}

		ensureToday(false);
		return self;
	}

	function ensureToday(carryBase, timestamp) {
		const at = timestamp === undefined ? now() : timestamp;
		const key = dayKey(new Date(at));
		if (today && today.date === key)
			return { changed: false, previousDate: null };

		const previous = today;
		const carry = carryBase && previous && previous.base !== null;
		today = emptyDay(
			key,
			carry ? previous.base : null,
			carry ? previous.baseTime : null
		);
		save();
		return { changed: true, previousDate: previous ? previous.date : null };
	}

	function setBase(altitude, timestamp) {
		ensureToday(false, timestamp);
		today.base = Math.round(altitude);
		today.baseTime = timestamp === undefined ? now() : timestamp;
		today.closed = false;
		save();
		return today.base;
	}

	function aggregate(key) {
		if (!days[key]) {
			days[key] = {
				v: 0,
				r: 0,
				first: null,
				last: null,
				base: today.base,
			};
		}
		return days[key];
	}

	function addLift(lift) {
		ensureToday(false);
		const key = today.date;
		const seq = nextSeq++;
		const stored = {
			seq,
			startTime: lift.startTime,
			endTime: lift.endTime,
			startAltitude: Math.round(lift.startAltitude),
			peakAltitude: Math.round(lift.peakAltitude),
			gain: Math.round(lift.gain),
			durationMs: lift.durationMs,
			incomplete: !!lift.incomplete,
		};
		today.lifts.push(stored);

		const day = aggregate(key);
		day.v += stored.gain;
		day.r += 1;
		day.first = day.first === null ? stored.startTime : Math.min(day.first, stored.startTime);
		day.last = day.last === null ? stored.endTime : Math.max(day.last, stored.endTime);
		day.base = today.base;

		outbox.push(Object.assign({
			id: key + ":" + seq,
			kind: "lift",
			date: key,
			seq,
		}, stored));

		save();
		return stored;
	}

	function undoLastLift() {
		ensureToday(false);
		const key = today.date;
		const lift = today.lifts.pop();
		if (!lift)
			return null;

		const day = days[key];
		if (day) {
			day.v -= lift.gain;
			day.r -= 1;
			if (day.r <= 0 || day.v <= 0) {
				delete days[key];
			}
			else {
				let first = null;
				let last = null;
				for (const item of today.lifts) {
					first = first === null ? item.startTime : Math.min(first, item.startTime);
					last = last === null ? item.endTime : Math.max(last, item.endTime);
				}
				day.first = first;
				day.last = last;
			}
		}

		outbox.push({
			id: key + ":" + lift.seq + ":delete",
			kind: "lift-delete",
			date: key,
			seq: lift.seq,
		});
		save();
		return lift;
	}

	function endDay() {
		ensureToday(false);
		today.closed = true;
		save();
	}

	function resumeDay() {
		ensureToday(false);
		today.closed = false;
		save();
	}

	function setSettings(patch) {
		settings = mergeSettings(settings, patch || {});
		save();
	}

	function setPaused(paused) {
		settings.paused = !!paused;
		save();
	}

	function ack(id) {
		const before = outbox.length;
		outbox = outbox.filter(item => item.id !== id);
		if (outbox.length !== before)
			save();
	}

	function hasBase() {
		return !!(today && today.base !== null);
	}

	function isTracking() {
		return hasBase() && !today.closed && !settings.paused;
	}

	function todayStats() {
		const lifts = today ? today.lifts : [];
		let vertical = 0;
		let longest = 0;
		let first = null;
		let last = null;
		for (const lift of lifts) {
			vertical += lift.gain;
			longest = Math.max(longest, lift.gain);
			first = first === null ? lift.startTime : Math.min(first, lift.startTime);
			last = last === null ? lift.endTime : Math.max(last, lift.endTime);
		}
		return {
			runs: lifts.length,
			vertical,
			first,
			last,
			longest,
			average: lifts.length ? Math.round(vertical / lifts.length) : 0,
			lifts: lifts.slice(),
		};
	}

	function seasonSummary() {
		return summarize(days, settings, new Date(now()));
	}

	const self = {
		load,
		save,
		ensureToday,
		setBase,
		addLift,
		undoLastLift,
		endDay,
		resumeDay,
		setSettings,
		setPaused,
		ack,
		hasBase,
		isTracking,
		todayStats,
		seasonSummary,
		getSettings: () => clone(settings),
		getToday: () => (today ? clone(today) : null),
		getDays: () => clone(days),
		getOutbox: () => clone(outbox),
		getNextSeq: () => nextSeq,
	};

	return self;
}

export { STATE_KEY };
