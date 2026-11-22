/**
 * Slide Stats core: lift detection, seasons, persistence, and formatting.
 *
 * One module instead of four. Alloy charges memory per module at startup, and
 * the watch cannot spare it.
 */

/**
 * Pure ski-lift detector.
 *
 * No Pebble APIs live here so the state machine can be tested headlessly and
 * reused by the debug screen. Feed it GPS samples; it emits `start`, `end`, and
 * `discard` events.
 *
 * A sample is `{ t, altitude, altitudeAccuracy?, speed? }` with `t` in ms and
 * altitude in metres. Invalid samples are ignored.
 *
 * Detection runs on a median-filtered altitude so a single noisy fix cannot
 * start or end a ride. The lift's own start and peak are taken from raw
 * altitudes, because a filter that lags by one sample would quietly shave a few
 * metres off every short bunny lift.
 */

const DEFAULTS = {
	// Fast lifts: 10 m of net gain inside 30 s (0.33 m/s).
	fastGainM: 10,
	fastWindowMs: 30000,
	// Slow lifts: the same 10 m, but allowed to take up to 90 s (0.11 m/s).
	// This is what catches bunny lifts and magic carpets.
	slowGainM: 10,
	slowWindowMs: 90000,
	// A confirmed ride smaller than this is thrown away.
	minLiftGainM: 10,
	// A lift ends once altitude is 5 m below its peak for two samples.
	endDescentM: 5,
	endConfirmSamples: 2,
	// Reject samples from cars/roads. Speed is optional.
	maxSpeedMps: 8,
	// Reject unusable altitude fixes.
	maxAltitudeAccuracyM: 30,
	// Median filter width, in samples.
	medianSamples: 3,
	// Keep a little more history than the slow window needs.
	historyMs: 180000,
	// A gap longer than this finalises an in-progress ride and clears windows.
	gapResetMs: 300000,
};

const RISE_EPSILON_M = 0.3;

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	if (sorted.length & 1)
		return sorted[middle];
	return (sorted[middle - 1] + sorted[middle]) / 2;
}

function finite(value) {
	return typeof value === "number" && isFinite(value);
}

function createLiftDetector(options = {}) {
	let config = Object.assign({}, DEFAULTS, options);
	let phase = "idle";
	let active = null;
	let history = [];		// { t, raw, smooth }
	let rawAltitudes = [];
	let endCount = 0;
	let lastSeenTime = null;
	let lastAcceptedTime = null;
	let lastAltitude = null;

	function reset() {
		phase = "idle";
		active = null;
		history = [];
		rawAltitudes = [];
		endCount = 0;
		lastSeenTime = null;
		lastAcceptedTime = null;
		lastAltitude = null;
	}

	function setOptions(next = {}) {
		config = Object.assign({}, config, next);
	}

	function prune(now) {
		const oldest = now - config.historyMs;
		let index = 0;
		while (index < history.length && history[index].t < oldest)
			index++;
		if (index)
			history = history.slice(index);
	}

	function windowSamples(now, windowMs) {
		const oldest = now - windowMs;
		const result = [];
		for (let i = 0; i < history.length; i++) {
			if (history[i].t >= oldest)
				result.push(history[i]);
		}
		return result;
	}

	function lowest(samples) {
		let result = samples[0];
		for (let i = 1; i < samples.length; i++) {
			if (samples[i].smooth < result.smooth)
				result = samples[i];
		}
		return result;
	}

	function isRising(samples, gainM) {
		if (samples.length < 2)
			return false;
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (last.smooth - first.smooth < gainM)
			return false;

		let rising = 0;
		let falling = 0;
		for (let i = 1; i < samples.length; i++) {
			const delta = samples[i].smooth - samples[i - 1].smooth;
			if (delta > RISE_EPSILON_M)
				rising++;
			else if (delta < -RISE_EPSILON_M)
				falling++;
		}
		const moves = rising + falling;
		return moves > 0 && (rising / moves) >= 0.6;
	}

	function makeLift(start, peak, incomplete) {
		return {
			startTime: start.t,
			endTime: peak.t,
			startAltitude: start.alt,
			peakAltitude: peak.alt,
			gain: peak.alt - start.alt,
			durationMs: peak.t - start.t,
			incomplete,
		};
	}

	function finishLift(incomplete) {
		const lift = makeLift(active.start, active.peak, incomplete);
		phase = "idle";
		active = null;
		endCount = 0;
		// Keep only the sample that confirmed the end. Otherwise the climb we
		// just finished can still be inside the 90 s window and start itself
		// again on the next sample.
		if (history.length)
			history = [history[history.length - 1]];
		if (lift.gain < config.minLiftGainM)
			return { type: "discard", lift };
		return { type: "end", lift };
	}

	function startLift(now) {
		const samples = windowSamples(now, config.slowWindowMs);
		if (samples.length < 2)
			return null;

		const fast = windowSamples(now, config.fastWindowMs);
		const fastOk = isRising(fast, config.fastGainM);
		const slowOk = samples.length >= 3 && isRising(samples, config.slowGainM);
		if (!fastOk && !slowOk)
			return null;

		// The bottom of the climb is the lowest smoothed sample in the slow
		// window. Use its raw altitude so the recorded gain is not filtered.
		const bottom = lowest(samples);
		const latest = samples[samples.length - 1];
		const start = { t: bottom.t, alt: bottom.raw };

		phase = "lift";
		active = {
			start,
			peak: { t: latest.t, alt: latest.raw },
		};
		endCount = 0;
		const lift = makeLift(active.start, active.peak, false);
		lift.endTime = undefined;
		lift.durationMs = undefined;
		return { type: "start", lift };
	}

	function updateLift(now, raw) {
		if (raw > active.peak.alt) {
			active.peak.t = now;
			active.peak.alt = raw;
		}

		const descent = active.peak.alt - raw;
		if (descent >= config.endDescentM) {
			endCount++;
			if (endCount >= config.endConfirmSamples)
				return finishLift(false);
		}
		else
			endCount = 0;
		return null;
	}

	function addSample(sample) {
		if (!sample)
			return [];
		const altitude = sample.altitude;
		if (!finite(altitude))
			return [];

		const now = finite(sample.t) ? sample.t : Date.now();
		if (lastSeenTime !== null && now <= lastSeenTime)
			return [];		// stale or duplicate
		lastSeenTime = now;

		const events = [];

		// A long gap means we cannot trust the window any more. If a ride was
		// in progress, close it at the last peak so its known gain is kept.
		if (lastAcceptedTime !== null && now - lastAcceptedTime > config.gapResetMs) {
			if (phase === "lift")
				events.push(finishLift(true));
			history = [];
			rawAltitudes = [];
			endCount = 0;
		}

		if (finite(sample.altitudeAccuracy) && sample.altitudeAccuracy > config.maxAltitudeAccuracyM)
			return events;
		if (finite(sample.speed) && sample.speed > config.maxSpeedMps)
			return events;

		lastAcceptedTime = now;
		lastAltitude = altitude;

		rawAltitudes.push(altitude);
		if (rawAltitudes.length > config.medianSamples)
			rawAltitudes.shift();
		const smoothed = median(rawAltitudes);

		history.push({ t: now, raw: altitude, smooth: smoothed });
		prune(now);

		if (phase === "idle") {
			const event = startLift(now);
			if (event)
				events.push(event);
		}
		else {
			const event = updateLift(now, altitude);
			if (event)
				events.push(event);
		}
		return events;
	}

	function state() {
		let candidateGain = 0;
		let candidateWindow = 0;
		const now = lastAcceptedTime;
		if (now !== null) {
			const samples = windowSamples(now, config.slowWindowMs);
			if (samples.length >= 2) {
				const low = lowest(samples);
				const latest = samples[samples.length - 1];
				candidateGain = latest.smooth - low.smooth;
				candidateWindow = now - samples[0].t;
			}
		}
		return {
			phase,
			lift: active ? {
				startTime: active.start.t,
				startAltitude: active.start.alt,
				peakTime: active.peak.t,
				peakAltitude: active.peak.alt,
				gain: active.peak.alt - active.start.alt,
			} : null,
			candidateGain,
			candidateWindow,
			lastAltitude,
			lastSampleTime: lastAcceptedTime,
			endCount,
		};
	}

	return {
		addSample,
		state,
		reset,
		setOptions,
		config: () => Object.assign({}, config),
	};
}



/* ------------------------------------------------------------------ */
/* Seasons and trips                                                   */
/* ------------------------------------------------------------------ */

/**
 * Date keys, ski seasons, and trip grouping. Pure functions, no Pebble APIs.
 *
 * A season is a 12-month window identified by its start year. The northern
 * preset starts on 1 September; the southern preset starts on 1 March.
 */

const NORTH = { mode: "north", month: 9, day: 1 };
const SOUTH = { mode: "south", month: 3, day: 1 };

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

/** Days since the UTC epoch, used only for calendar-day differences. */
function dayNumber(key) {
	const parts = key.split("-");
	return Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000);
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

function totalsFor(keys, days) {
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

function summarize(days, settings, now) {
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


/* ------------------------------------------------------------------ */
/* Day store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Persistent day/session state.
 *
 * One JSON blob in localStorage keeps flash writes to a minimum: settings,
 * per-day aggregates, today's lifts, the sync outbox, and the lift sequence.
 * The storage adapter is injected so tests can run headlessly.
 */

const STATE_KEY = "ss.state";
const STATE_VERSION = 1;

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

function emptyDay(key) {
	return {
		date: key,
		closed: false,
		lifts: [],
	};
}

function createDayStore(options = {}) {
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

	function aggregate(key) {
		if (!days[key]) {
			days[key] = {
				v: 0,
				r: 0,
				first: null,
				last: null,
			};
		}
		return days[key];
	}

	function addLift(lift) {
		ensureToday();
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
		ensureToday();
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
		ensureToday();
		today.closed = true;
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

	function isTracking() {
		return !!today && !today.closed && !settings.paused;
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
		addLift,
		undoLastLift,
		endDay,
		resumeDay,
		setSettings,
		setPaused,
		ack,
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

function fromFeet(feet) {
	return feet / METRES_TO_FEET;
}

function unitLabel(units, short) {
	if (units === "imperial")
		return short ? "ft" : "feet";
	return short ? "m" : "metres";
}

function formatAltitude(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? toFeet(metres) : metres;
	return groupThousands(value) + " " + unitLabel(units, true);
}

function formatVertical(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? toFeet(metres) : metres;
	const rounded = Math.round(value);
	const sign = rounded > 0 ? "+" : "";
	return sign + groupThousands(rounded) + " " + unitLabel(units, true);
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
	return MONTHS[month - 1] + " " + day;
}

function formatDateRange(startKey, endKey) {
	return startKey === endKey
		? formatDateShort(startKey)
		: formatDateShort(startKey) + " - " + formatDateShort(endKey);
}

function formatDuration(ms) {
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

function formatAverage(value, units) {
	if (!isFinite(value))
		return "--";
	return groupThousands(units === "imperial" ? toFeet(value) : value) + " " + unitLabel(units, true);
}


export {
	createLiftDetector,
	DEFAULTS,
	createDayStore,
	DEFAULT_SETTINGS,
	STATE_KEY,
	dayKey,
	dateFromKey,
	dayNumber,
	seasonKey,
	seasonLabel,
	currentSeasonKey,
	summarize,
	groupTrips,
	totalsFor,
	pad2,
	groupThousands,
	toFeet,
	fromFeet,
	unitLabel,
	formatAltitude,
	formatVertical,
	formatClock,
	formatTime,
	formatDateShort,
	formatDateRange,
	formatDuration,
	formatAverage,
};
