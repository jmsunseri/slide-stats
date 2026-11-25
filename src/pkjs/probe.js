/*
 * Temporary phone-side probe for the phone-authoritative redesign.
 *
 * It has two jobs:
 *  1. prove the shared lift detector runs in PKJS;
 *  2. report whether PKJS exposes geolocation and what altitude data it has.
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
	console.log("phone-probe: detector events=" +
		events.map(event => event.type).join(","));
}

function logGeolocationProbe() {
	if (typeof navigator === "undefined" || !navigator.geolocation) {
		console.log("phone-probe: geolocation unavailable");
		return;
	}
	console.log("phone-probe: geolocation available");
	navigator.geolocation.watchPosition(
		position => {
			const coords = position.coords;
			console.log("phone-probe: position lat=" + coords.latitude +
				" lon=" + coords.longitude +
				" accuracy=" + coords.accuracy +
				" altitude=" + coords.altitude +
				" altitudeAccuracy=" + coords.altitudeAccuracy);
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
