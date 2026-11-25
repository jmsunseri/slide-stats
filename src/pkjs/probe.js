/*
 * Temporary phone-side probe for the phone-authoritative redesign.
 *
 * It has three jobs:
 *  1. prove the shared lift detector runs in PKJS with a synthetic trace;
 *  2. feed live geolocation into the same detector and log start/end events;
 *  3. report whether PKJS exposes geolocation and what altitude data it has.
 *
 * Set PHONE_PROBE to true in src/pkjs/index.js to run it.
 */

let started = false;

function logDetectorProbe() {
	const { createLiftDetector } = require("./lib/detector.js");
	const detector = createLiftDetector();
	const now = Date.now();
	const events = [];
	for (let second = 0; second <= 30; second++)
		events.push(...detector.addSample({
			t: now + second * 1000,
			altitude: 2000 + second,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		}));
	for (let second = 0; second <= 6; second++)
		events.push(...detector.addSample({
			t: now + (31 + second) * 1000,
			altitude: 2030 - second * 2,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		}));
	console.log("phone-probe: synthetic detector events=" +
		events.map(event => event.type).join(","));
}

function logGeolocationProbe() {
	if (typeof navigator === "undefined" || !navigator.geolocation) {
		console.log("phone-probe: geolocation unavailable");
		return;
	}
	console.log("phone-probe: geolocation available");
	const { createPhoneStore } = require("./lib/phone-store");
	const { createPhoneDetector } = require("./lib/phone-detector");
	const { DEFAULT_SETTINGS } = require("./lib/settings");
	const storage = {
		getItem: key => localStorage.getItem(key),
		setItem: (key, value) => localStorage.setItem(key, value),
	};
	const store = createPhoneStore({ storage, key: "ss.phoneProbeLifts" });
	function phoneSettings() {
		try {
			const raw = localStorage.getItem("ss.settings");
			return raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
		}
		catch (error) {
			return DEFAULT_SETTINGS;
		}
	}
	const detector = createPhoneDetector({
		store,
		getSettings: phoneSettings,
		onEvent(event) {
			if (event.type === "start") {
				console.log("phone-probe: live start start=" + event.lift.startTime);
				return;
			}
			console.log("phone-probe: live end gain=" + event.record.gain +
				" today=" + event.state.today.runs + " runs/" +
				event.state.today.vertical + " m" +
				" season=" + event.state.season.runs + " runs/" +
				event.state.season.vertical + " m");
		},
	});
	navigator.geolocation.watchPosition(
		position => {
			const coords = position.coords;
			console.log("phone-probe: position lat=" + coords.latitude +
				" lon=" + coords.longitude +
				" accuracy=" + coords.accuracy +
				" altitude=" + coords.altitude +
				" altitudeAccuracy=" + coords.altitudeAccuracy);
			detector.addSample({
				t: Date.now(),
				altitude: coords.altitude,
				altitudeAccuracy: coords.altitudeAccuracy,
				latitude: coords.latitude,
				longitude: coords.longitude,
			});
		},
		error => {
			console.log("phone-probe: geolocation error " + JSON.stringify(error));
		},
		{ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
	);
}

function start() {
	if (started)
		return;
	started = true;
	try {
		logDetectorProbe();
	}
	catch (error) {
		console.log("phone-probe: detector failed " + error);
	}
	try {
		logGeolocationProbe();
	}
	catch (error) {
		console.log("phone-probe: geolocation probe failed " + error);
	}
}

module.exports = { start };
