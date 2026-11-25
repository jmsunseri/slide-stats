/**
 * Persistent day/session state used by the headless tests and the legacy
 * watch store. The phone-authoritative watch no longer imports this module.
 *
 * One JSON blob in localStorage keeps flash writes to a minimum: settings,
 * per-day aggregates, today's lifts, the sync outbox, and the lift sequence.
 * The storage adapter is injected so tests can run headlessly.
 */

import { finite, scaledCoord } from "./detector.js";
import { dayKey } from "./format.js";

/**
 * Persistent day/session state.
 *
 * One JSON blob in localStorage keeps flash writes to a minimum: settings,
 * per-day aggregates, today's lifts, the sync outbox, and the lift sequence.
 * The storage adapter is injected so tests can run headlessly.
 */

const STATE_KEY = "ss.state";
const STATE_VERSION = 1;
const ACTIVE_SAVE_INTERVAL_MS = 30000;

const DEFAULT_SETTINGS = {
	units: "metric",
	vibration: true,
	paused: false,
	sampleIntervalMs: 10000,
	seasonMode: "north",
	trips: true,
	detection: {
		fastGainM: 10,
		fastWindowMs: 30000,
		slowGainM: 10,
		slowWindowMs: 90000,
		minLiftGainM: 10,
		endDescentM: 5,
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

function emptyDay(key) {
	return {
		date: key,
		closed: false,
		lifts: [],
		active: null,
	};
}

function makeUid(date, seq) {
	return date + ":" + seq + ":" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function packPoints(lift) {
	if (!(finite(lift.startLat) && finite(lift.startLon) &&
		finite(lift.peakLat) && finite(lift.peakLon)))
		return null;
	return [
		scaledCoord(lift.startLat),
		scaledCoord(lift.startLon),
		scaledCoord(lift.peakLat),
		scaledCoord(lift.peakLon),
	];
}

function createDayStore(options = {}) {
	const storage = options.storage;
	const now = options.now || (() => Date.now());

	let settings = clone(DEFAULT_SETTINGS);
	let today = null;
	let outbox = [];
	let nextSeq = 1;
	let activeSavedAt = 0;

	function save() {
		if (!storage)
			return;
		try {
			storage.setItem(STATE_KEY, JSON.stringify({
				v: STATE_VERSION,
				settings,
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
			today = stored.today || null;
			outbox = stored.outbox || [];
			nextSeq = stored.nextSeq || 1;
		}

		ensureToday();
		return self;
	}

	function ensureToday(timestamp) {
		const at = timestamp === undefined ? now() : timestamp;
		const key = dayKey(new Date(at));
		if (today && today.date === key)
			return { changed: false, previousDate: null };

		const previous = today;
		today = emptyDay(key);
		save();
		return { changed: true, previousDate: previous ? previous.date : null };
	}

	function addLift(lift) {
		ensureToday();
		today.active = null;
		const key = today.date;
		const seq = nextSeq++;
		const uid = makeUid(key, seq);
		const stored = {
			seq,
			uid,
			startTime: lift.startTime,
			endTime: lift.endTime,
			startAltitude: Math.round(lift.startAltitude),
			peakAltitude: Math.round(lift.peakAltitude),
			gain: Math.round(lift.gain),
			durationMs: lift.durationMs,
		};
		today.lifts.push(stored);

		const record = Object.assign({
			id: uid,
			kind: "lift",
			date: key,
			seq,
			uid,
		}, stored);
		const pts = packPoints(lift);
		if (pts)
			record.pts = pts;
		outbox.push(record);

		save();
		return stored;
	}

	function undoLastLift() {
		ensureToday();
		const key = today.date;
		const lift = today.lifts.pop();
		if (!lift)
			return null;

		outbox.push({
			id: lift.uid + ":delete",
			kind: "lift-delete",
			date: key,
			seq: lift.seq,
			uid: lift.uid,
		});
		save();
		return lift;
	}

	function purgeDay(date) {
		ensureToday();
		if (!today || today.date !== date)
			return false;
		today.lifts = [];
		today.active = null;
		today.closed = false;
		outbox = outbox.filter(item => item.date !== date);
		save();
		return true;
	}

	function endDay() {
		ensureToday();
		today.closed = true;
		today.active = null;
		save();
	}

	function resumeDay() {
		ensureToday();
		today.closed = false;
		save();
	}

	function setSettings(patch) {
		settings = mergeSettings(settings, patch || {});
		save();
		return clone(settings);
	}

	function setPaused(paused) {
		settings.paused = !!paused;
		if (settings.paused && today) {
			today.active = null;
			}
		save();
		return clone(settings);
	}

	function ack(id) {
		const before = outbox.length;
		outbox = outbox.filter(item => item.id !== id);
		if (outbox.length !== before)
			save();
	}

	function setActiveLift(lift) {
		if (!lift && !today.active)
			return;
		today.active = lift;
		if (!lift) {
			activeSavedAt = 0;
			save();
			return;
		}
		const at = now();
		if (at - activeSavedAt >= ACTIVE_SAVE_INTERVAL_MS) {
			save();
			activeSavedAt = at;
		}
	}

	function isTracking() {
		return !!today && !today.closed && !settings.paused;
	}

	function isClosed() {
		return !!(today && today.closed);
	}

	function todayDate() {
		return today ? today.date : null;
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
		};
	}

	const self = {
		load,
		save,
		ensureToday,
		addLift,
		undoLastLift,
		purgeDay,
		endDay,
		resumeDay,
		setSettings,
		setPaused,
		ack,
		isTracking,
		isClosed,
		todayDate,
		todayStats,
		setActiveLift,
		getSettings: () => clone(settings),
		getToday: () => (today ? clone(today) : null),
		getActiveLift: () => (today && today.active ? clone(today.active) : null),
		getOutbox: () => clone(outbox),
		peekOutbox: () => (outbox.length ? clone(outbox[0]) : null),
	};

	return self;
}

export { createDayStore, DEFAULT_SETTINGS, STATE_KEY };
