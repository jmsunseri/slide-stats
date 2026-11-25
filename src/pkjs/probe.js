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
	const { createLiftDetector } = require("./lib/detector.js");
	const detector = createLiftDetector();
	navigator.geolocation.watchPosition(
		position => {
			const coords = position.coords;
			console.log("phone-probe: position lat=" + coords.latitude +
				" lon=" + coords.longitude +
				" accuracy=" + coords.accuracy +
				" altitude=" + coords.altitude +
				" altitudeAccuracy=" + coords.altitudeAccuracy);
			const events = detector.addSample({
				t: Date.now(),
				altitude: coords.altitude,
				altitudeAccuracy: coords.altitudeAccuracy,
				latitude: coords.latitude,
				longitude: coords.longitude,
			});
			for (const event of events) {
				console.log("phone-probe: live " + event.type +
					(event.lift
						? " gain=" + Math.round(event.lift.gain) +
							" start=" + event.lift.startTime
						: ""));
			}
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
