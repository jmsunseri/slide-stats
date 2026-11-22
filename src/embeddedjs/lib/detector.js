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

export function createLiftDetector(options = {}) {
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

export { DEFAULTS };
