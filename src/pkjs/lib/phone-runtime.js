/*
 * Phone-authoritative runtime.
 *
 * Owns geolocation, the shared detector, the phone lift store, settings, and
 * the compact state pushed to the watch. The watch only displays this state
 * and sends commands back.
 */

const { createPhoneStore } = require("./phone-store");
const { createPhoneDetector } = require("./phone-detector");
const { DEFAULT_SETTINGS } = require("./settings");
const stats = require("./stats");

const ACTIVE_KEY = "ss.phoneActive";
const ACTIVE_SAVE_MS = 30000;

function finite(value) {
	return typeof value === "number" && isFinite(value);
}

function mergeSettings(stored, current) {
	const source = stored || {};
	const base = current || {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, base, source);
	settings.theme = Object.assign({}, DEFAULT_SETTINGS.theme, base.theme || {}, source.theme || {});
	settings.detection = Object.assign(
		{}, DEFAULT_SETTINGS.detection, base.detection || {}, source.detection || {}
	);
	settings.paused = source.paused !== undefined ? !!source.paused : !!base.paused;
	settings.closed = source.closed !== undefined ? !!source.closed : !!base.closed;
	if (!settings.closed)
		settings.closedDate = null;
	else if (source.closedDate !== undefined)
		settings.closedDate = source.closedDate;
	else
		settings.closedDate = base.closedDate || null;
	return settings;
}

function createPhoneRuntime(options = {}) {
	const storage = options.storage;
	const loadSettings = options.loadSettings || (() => null);
	const saveSettings = options.saveSettings || (() => {});
	const emitState = options.onState || (() => {});
	const emitEvent = options.onEvent || (() => {});
	const geolocation = options.geolocation !== undefined
		? options.geolocation
		: (typeof navigator !== "undefined" ? navigator.geolocation : null);
	const now = options.now || (() => Date.now());

	const store = createPhoneStore({ storage, key: "ss.lifts", now });
	let settings = mergeSettings(loadSettings());
	let gps = false;
	let watchId = null;
	let started = false;
	let lastProcessed = 0;
	let lastActiveSave = 0;
	let activeStored = false;
	let dayKey = stats.dayKey(new Date(now()));
	let stateSeq = 0;

	function saveActive(force) {
		if (!storage)
			return;
		const snapshot = detector.snapshot();
		if (!snapshot) {
			if (activeStored && storage.removeItem) {
				try {
					storage.removeItem(ACTIVE_KEY);
				}
				catch (error) {
					console.log("phone-runtime: active clear failed " + error);
				}
				activeStored = false;
			}
			return;
		}
		const at = now();
		if (!force && at - lastActiveSave < ACTIVE_SAVE_MS)
			return;
		try {
			storage.setItem(ACTIVE_KEY, JSON.stringify({
				date: stats.dayKey(new Date(snapshot[0])),
				snapshot,
			}));
			lastActiveSave = at;
			activeStored = true;
		}
		catch (error) {
			console.log("phone-runtime: active save failed " + error);
		}
	}

	function clearActive() {
		detector.reset();
		lastActiveSave = 0;
		activeStored = false;
		if (storage && storage.removeItem) {
			try {
				storage.removeItem(ACTIVE_KEY);
			}
			catch (error) {
				console.log("phone-runtime: active clear failed " + error);
			}
		}
	}

	function restoreActive() {
		if (!storage)
			return;
		try {
			const raw = storage.getItem(ACTIVE_KEY);
			if (!raw)
				return;
			const active = JSON.parse(raw);
			if (active && active.date === dayKey && active.snapshot &&
				(active.snapshot.length === 4 || active.snapshot.length === 8)) {
				detector.restore(active.snapshot);
				lastActiveSave = now();
				activeStored = true;
			}
			else if (storage.removeItem)
				storage.removeItem(ACTIVE_KEY);
		}
		catch (error) {
			console.log("phone-runtime: active restore failed " + error);
		}
	}

	const detector = createPhoneDetector({
		store,
		getSettings: () => settings,
		onEvent(event) {
			if (event.type === "start") {
				saveActive(true);
				emitEvent({ type: "start" });
				return;
			}
			saveActive(true);
			console.log("phone-runtime: lift end " +
				(event.record ? event.record.gain : 0) + " m");
			emitEvent({
				type: "end",
				gain: event.record ? event.record.gain : 0,
			});
			sendState();
		},
	});

	function buildState() {
		const state = store.state(settings, new Date(now()));
		state.seq = ++stateSeq;
		state.status = { gps };
		return state;
	}

	function sendState() {
		checkDay(false);
		try {
			emitState(buildState());
		}
		catch (error) {
			console.log("phone-runtime: state emit failed " + error);
		}
	}

	function pauseTracking() {
		clearActive();
		stopGeolocation();
	}

	function resumeTracking() {
		lastProcessed = 0;
		startGeolocation();
	}

	function applySettings(next) {
		settings = mergeSettings(next, settings);
		detector.setOptions(settings.detection);
		if (started) {
			if (settings.paused || settings.closed)
				pauseTracking();
			else
				resumeTracking();
			sendState();
		}
		return settings;
	}

	function onPosition(position) {
		checkDay(true);
		const coords = position.coords;
		const hasAltitude = finite(coords.altitude);
		if (hasAltitude !== gps) {
			gps = hasAltitude;
			console.log("phone-runtime: gps " + (gps ? "on" : "off"));
			sendState();
		}
		if (!hasAltitude)
			return;

		const at = now();
		const interval = settings.sampleIntervalMs || 10000;
		if (at - lastProcessed < interval)
			return;
		lastProcessed = at;

		detector.addSample({
			t: at,
			altitude: coords.altitude,
			altitudeAccuracy: coords.altitudeAccuracy,
			latitude: coords.latitude,
			longitude: coords.longitude,
		});
		saveActive(false);
	}

	function onError(error) {
		console.log("phone-runtime: geolocation error " + JSON.stringify(error));
		if (gps) {
			gps = false;
			sendState();
		}
	}

	function startGeolocation() {
		if (watchId !== null || !geolocation || settings.paused || settings.closed)
			return;
		gps = false;
		watchId = geolocation.watchPosition(onPosition, onError, {
			enableHighAccuracy: true,
			maximumAge: 0,
			timeout: 10000,
		});
	}

	function stopGeolocation() {
		if (watchId !== null && geolocation) {
			try {
				geolocation.clearWatch(watchId);
			}
			catch (error) {
				console.log("phone-runtime: geolocation clear failed " + error);
			}
		}
		watchId = null;
		gps = false;
	}

	function commitSettings() {
		saveSettings(settings);
		sendState();
	}

	function handleCommand(raw) {
		let command = raw;
		if (typeof raw === "string") {
			try {
				command = JSON.parse(raw);
			}
			catch (error) {
				console.log("phone-runtime: bad command " + error);
				return;
			}
		}
		if (!command || !command.type)
			return;
		console.log("phone-runtime: command " + command.type);

		if (command.type === "day") {
			settings.closed = !!command.value;
			settings.closedDate = settings.closed ? stats.dayKey(new Date(now())) : null;
			if (settings.closed)
				pauseTracking();
			else
				resumeTracking();
			commitSettings();
		}
		else if (command.type === "pause") {
			settings.paused = !!command.value;
			if (settings.paused)
				pauseTracking();
			else
				resumeTracking();
			commitSettings();
		}
		else if (command.type === "undo") {
			store.undoLastLift(stats.dayKey(new Date(now())));
			sendState();
		}
		else if (command.type === "units") {
			settings.units = command.value === "imperial" ? "imperial" : "metric";
			commitSettings();
		}
		else if (command.type === "vibration") {
			settings.vibration = !!command.value;
			commitSettings();
		}
		else if (command.type === "refresh") {
			sendState();
		}
	}

	function checkDay(emit) {
		const next = stats.dayKey(new Date(now()));
		if (next === dayKey)
			return false;
		dayKey = next;
		clearActive();
		settings.closed = false;
		settings.closedDate = null;
		saveSettings(settings);
		if (started && !settings.paused) {
			lastProcessed = 0;
			startGeolocation();
		}
		if (emit)
			sendState();
		return true;
	}

	function start() {
		if (started)
			return false;
		started = true;
		detector.setOptions(settings.detection);
		const today = stats.dayKey(new Date(now()));
		if (settings.closed && settings.closedDate !== today) {
			settings.closed = false;
			settings.closedDate = null;
			saveSettings(settings);
		}
		if (!settings.paused && !settings.closed) {
			restoreActive();
			startGeolocation();
		}
		sendState();
		return true;
	}

	function stop() {
		stopGeolocation();
		started = false;
	}

	return {
		start,
		stop,
		sendState,
		applySettings,
		handleCommand,
		handlePosition: onPosition,
		handleError: onError,
		buildState,
		getSettings: () => settings,
		getStore: () => store,
	};
}

module.exports = { createPhoneRuntime };
