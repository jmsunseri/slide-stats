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
 * A sample is `{ t, altitude, altitudeAccuracy? }` with `t` in ms and
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

function hasPoint(point) {
	return finite(point.lat) && finite(point.lon);
}

function scaledCoord(value) {
	return Math.round(value * 1e6);
}

function point(t, alt, sample) {
	const result = { t, alt };
	if (hasPoint(sample)) {
		result.lat = sample.lat;
		result.lon = sample.lon;
	}
	return result;
}

function createLiftDetector(options = {}) {
	let config = Object.assign({}, DEFAULTS, options);
	let phase = "idle";
	let active = null;
	let history = [];		// { t, raw, smooth, lat?, lon? }
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

	function makeLift(start, peak) {
		const lift = {
			startTime: start.t,
			endTime: peak.t,
			startAltitude: start.alt,
			peakAltitude: peak.alt,
			gain: peak.alt - start.alt,
			durationMs: peak.t - start.t,
		};
		if (hasPoint(start)) {
			lift.startLat = start.lat;
			lift.startLon = start.lon;
		}
		if (hasPoint(peak)) {
			lift.peakLat = peak.lat;
			lift.peakLon = peak.lon;
		}
		return lift;
	}

	function finishLift() {
		const lift = makeLift(active.start, active.peak);
		phase = "idle";
		active = null;
		endCount = 0;
		// Keep only the sample that confirmed the end. Otherwise the climb we
		// just finished can still be inside the 90 s window and start itself
		// again on the next sample.
		if (history.length)
			history = [history[history.length - 1]];
		if (lift.gain < config.minLiftGainM)
			return null;
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

		phase = "lift";
		active = {
			start: point(bottom.t, bottom.raw, bottom),
			peak: point(latest.t, latest.raw, latest),
		};
		endCount = 0;
		const lift = makeLift(active.start, active.peak);
		lift.endTime = undefined;
		lift.durationMs = undefined;
		return { type: "start", lift };
	}

	function updateLift(now, raw, lat, lon) {
		if (raw > active.peak.alt) {
			active.peak.t = now;
			active.peak.alt = raw;
			if (finite(lat) && finite(lon)) {
				active.peak.lat = lat;
				active.peak.lon = lon;
			}
		}

		const descent = active.peak.alt - raw;
		if (descent >= config.endDescentM) {
			endCount++;
			if (endCount >= config.endConfirmSamples)
				return finishLift();
		}
		else
			endCount = 0;
		return null;
	}

	function snapshot() {
		if (!active)
			return null;
		const state = [active.start.t, active.start.alt, active.peak.t, active.peak.alt];
		// Coordinates are scaled to keep the persisted day small.
		if (hasPoint(active.start) && hasPoint(active.peak)) {
			state.push(
				scaledCoord(active.start.lat),
				scaledCoord(active.start.lon),
				scaledCoord(active.peak.lat),
				scaledCoord(active.peak.lon)
			);
		}
		return state;
	}

	function restore(state) {
		reset();
		if (!state || (state.length !== 4 && state.length !== 8))
			return;
		phase = "lift";
		active = {
			start: { t: state[0], alt: state[1] },
			peak: { t: state[2], alt: state[3] },
		};
		if (state.length === 8) {
			active.start.lat = state[4] / 1e6;
			active.start.lon = state[5] / 1e6;
			active.peak.lat = state[6] / 1e6;
			active.peak.lon = state[7] / 1e6;
		}
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

		// A long gap means the ascent window is stale, but an active ride stays
		// active: the next samples either extend its peak or end it on descent.
		if (lastAcceptedTime !== null && now - lastAcceptedTime > config.gapResetMs) {
			history = [];
			rawAltitudes = [];
			endCount = 0;
		}

		if (finite(sample.altitudeAccuracy) && sample.altitudeAccuracy > config.maxAltitudeAccuracyM)
			return events;

		lastAcceptedTime = now;
		lastAltitude = altitude;

		rawAltitudes.push(altitude);
		if (rawAltitudes.length > config.medianSamples)
			rawAltitudes.shift();
		const smoothed = median(rawAltitudes);

		const entry = { t: now, raw: altitude, smooth: smoothed };
		if (finite(sample.latitude) && finite(sample.longitude)) {
			entry.lat = sample.latitude;
			entry.lon = sample.longitude;
		}
		history.push(entry);
		prune(now);

		if (phase === "idle") {
			const event = startLift(now);
			if (event)
				events.push(event);
		}
		else {
			const event = updateLift(now, altitude, entry.lat, entry.lon);
			if (event)
				events.push(event);
		}
		return events;
	}

	return {
		addSample,
		snapshot,
		restore,
		reset,
		setOptions,
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
	}

	function setPaused(paused) {
		settings.paused = !!paused;
		if (settings.paused && today)
			today.active = null;
		save();
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
		save();
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
	createLiftDetector,
	DEFAULTS,
	createDayStore,
	DEFAULT_SETTINGS,
	STATE_KEY,
	dayKey,
	dateFromKey,
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
