import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Location from "embedded:sensor/Location";
import Message from "pebble/message";

import * as Core from "core";

const VERSION = "0.1.0";
const DEBUG = true;

const storage = {
	getItem: key => localStorage.getItem(key),
	setItem: (key, value) => localStorage.setItem(key, value),
};

let store = Core.createDayStore({ storage }).load();
let settings = store.getSettings();
let detector = Core.createLiftDetector(settings.detection);
let location = null;
let message = null;
let messageReady = false;
let sendingLift = false;
let ackTimer = null;
let onLift = false;
let statusNoGps = false;
let lastAltitude = null;
let recentAltitudes = [];
let lastProcessed = 0;
let lastPromptAltitude = null;
let mockTimer = null;

let menuOpen = false;
let menuIndex = 0;
let currentScreen = "main";

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const render = new Poco(screen);
const white = render.makeColor(255, 255, 255);
const black = render.makeColor(0, 0, 0);

const fontTime = new render.Font("Bitham-Bold", 42);
const fontAltitude = new render.Font("Gothic-Bold", 28);
const fontStats = new render.Font("Gothic-Regular", 18);
const fontStatus = new render.Font("Gothic-Regular", 14);
const fontTitle = new render.Font("Gothic-Bold", 18);
const fontRow = new render.Font("Gothic-Regular", 18);
const fontRowBold = new render.Font("Gothic-Bold", 18);
const fontMenu = new render.Font("Gothic-Regular", 14);

const W = render.width;
const H = render.height;
const ROUND = screen.round;
const MARGIN = ROUND ? 40 : 6;

function drawCentered(text, font, y) {
	const width = render.getTextWidth(text, font);
	render.drawText(text, font, black, (W - width) >> 1, y);
}

function drawRight(text, font, right, y) {
	const width = render.getTextWidth(text, font);
	render.drawText(text, font, black, right - width, y);
}

function isDayClosed() {
	const today = store.getToday();
	return !!(today && today.closed);
}

function statusText() {
	if (settings.paused)
		return "PAUSED";
	if (isDayClosed())
		return "DAY ENDED";
	if (statusNoGps || (store.hasBase() && lastAltitude === null))
		return "NO GPS";
	if (onLift)
		return "LIFT";
	return "";
}

function drawMain() {
	const stats = store.todayStats();
	drawCentered(Core.formatTime(new Date(), watch.hour12), fontTime, ROUND ? 30 : 14);

	let altitude;
	let statsText;
	if (store.hasBase()) {
		altitude = Core.formatAltitude(lastAltitude, settings.units);
		const runs = stats.runs + (stats.runs === 1 ? " RUN  " : " RUNS  ");
		statsText = runs + Core.formatVertical(stats.vertical, settings.units);
	}
	else {
		altitude = "SET BASE";
		statsText = lastAltitude === null
			? "WAITING FOR GPS"
			: Core.formatAltitude(lastAltitude, settings.units) + "  SELECT";
	}
	drawCentered(altitude, fontAltitude, ROUND ? 88 : 70);
	drawCentered(statsText, fontStats, ROUND ? 126 : 108);
	drawCentered(statusText(), fontStatus, ROUND ? 156 : 138);
}

function detailRows() {
	const stats = store.todayStats();
	const units = settings.units;
	if (currentScreen === "today") {
		return ["TODAY", [
			["Vertical", Core.formatVertical(stats.vertical, units)],
			["Runs", String(stats.runs)],
			["First", stats.first ? Core.formatTime(new Date(stats.first), watch.hour12) : "--"],
			["Last", stats.last ? Core.formatTime(new Date(stats.last), watch.hour12) : "--"],
			["Average", Core.formatAverage(stats.average, units)],
			["Longest", Core.formatVertical(stats.longest, units)],
		]];
	}
	if (currentScreen === "season") {
		const season = store.seasonSummary();
		return ["SEASON", [
			["Season", season.label],
			["Days", String(season.days)],
			["Vertical", Core.formatVertical(season.vertical, units)],
			["Runs", String(season.runs)],
			["Avg / day", Core.formatAverage(season.averageVertical, units)],
			["Best day", season.bestDay ? Core.formatDateShort(season.bestDay.date) : "--"],
		]];
	}
	return ["ABOUT", [
		["Slide Stats", VERSION],
		["Platform", ROUND ? "Gabbro" : "Emery"],
		["Units", units === "metric" ? "Metric" : "Imperial"],
		["Data", "Watch + phone"],
		["Stats", "Pebble app > Settings"],
		["Tracking", store.isTracking() ? "On" : "Off"],
	]];
}

function drawDetail() {
	const detail = detailRows();
	drawCentered(detail[0], fontTitle, ROUND ? 36 : 12);
	const rows = detail[1];
	const top = ROUND ? 66 : 40;
	for (let i = 0; i < rows.length; i++) {
		const y = top + i * 24;
		render.drawText(rows[i][0], fontRow, black, MARGIN, y);
		drawRight(rows[i][1], fontRowBold, W - MARGIN, y);
	}
}

function drawMenu() {
	const top = ROUND ? 32 : 12;
	for (let i = 0; i < MENU.length; i++)
		drawCentered((i === menuIndex ? "> " : "  ") + MENU[i].label(), fontMenu, top + i * 18);
}

function draw() {
	render.begin();
	render.fillRectangle(white, 0, 0, W, H);
	if (menuOpen)
		drawMenu();
	else if (currentScreen === "main")
		drawMain();
	else
		drawDetail();
	render.end();
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

const MENU = [
	{ id: "base", label: () => "Set Base" },
	{ id: "day", label: () => (isDayClosed() ? "Resume Day" : "End Day") },
	{ id: "pause", label: () => (settings.paused ? "Resume" : "Pause") },
	{ id: "undo", label: () => "Undo Last Lift" },
	{ id: "units", label: () => "Units: " + (settings.units === "metric" ? "Metric" : "Imperial") },
	{ id: "vibration", label: () => "Vibration: " + (settings.vibration ? "On" : "Off") },
	{ id: "sync", label: () => "Sync Now" },
	{ id: "about", label: () => "About" },
];
if (DEBUG)
	MENU.push({ id: "mock", label: () => "Debug: Mock Lift" });

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function updateAll() {
	settings = store.getSettings();
	draw();
}

function showScreen(name) {
	currentScreen = name;
	menuOpen = false;
	draw();
}

function openMenu() {
	menuOpen = true;
	menuIndex = 0;
	draw();
}

function closeMenu() {
	menuOpen = false;
	draw();
}

function updateMenu() {
	draw();
}

/* ------------------------------------------------------------------ */
/* GPS and detection                                                   */
/* ------------------------------------------------------------------ */

function smoothedAltitude(value) {
	recentAltitudes.push(value);
	if (recentAltitudes.length > 5)
		recentAltitudes.shift();
	const sorted = recentAltitudes.slice().sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
}

function startGps() {
	if (location)
		return;
	try {
		location = new Location({
			onSample() {
				const sample = this.sample();
				if (sample)
					handleSample(sample);
			},
			onError() {
				statusNoGps = true;
				draw();
			},
		});
		location.configure({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 });
	}
	catch (error) {
		console.log("slide-stats: gps start failed: " + error);
		statusNoGps = true;
	}
}

function stopGps() {
	if (!location)
		return;
	try {
		location.close();
	}
	catch (error) {
		console.log("slide-stats: gps close failed: " + error);
	}
	location = null;
}

function handleSample(sample) {
	const altitude = sample.altitude;
	const wasNoGps = statusNoGps;
	if (typeof altitude === "number" && isFinite(altitude)) {
		lastAltitude = smoothedAltitude(altitude);
		statusNoGps = false;
	}
	else {
		statusNoGps = true;
	}

	if (!store.hasBase() || settings.paused || isDayClosed()) {
		if (statusNoGps !== wasNoGps)
			draw();
		else if (!store.hasBase() && lastAltitude !== null &&
			(lastPromptAltitude === null || Math.abs(lastAltitude - lastPromptAltitude) >= 5)) {
			lastPromptAltitude = lastAltitude;
			draw();
		}
		return;
	}

	const now = Date.now();
	const interval = settings.sampleIntervalMs || 10000;
	if (now - lastProcessed < interval)
		return;
	lastProcessed = now;

	const events = detector.addSample({
		t: now,
		altitude,
		altitudeAccuracy: sample.altitudeAccuracy,
		speed: sample.speed,
	});
	handleEvents(events);
}

function handleEvents(events) {
	for (const event of events) {
		if (event.type === "start") {
			onLift = true;
			console.log("slide-stats: lift start");
			vibrate();
			draw();
		}
		else if (event.type === "end") {
			onLift = false;
			store.addLift(event.lift);
			console.log("slide-stats: lift end " + Math.round(event.lift.gain) + " m");
			vibrate();
			lastProcessed = 0;
			updateAll();
			flushOutbox();
		}
		else if (event.type === "discard") {
			onLift = false;
			draw();
		}
	}
}

function vibrate() {
	if (!settings.vibration)
		return;
	try {
		Vibes.doublePulse();
	}
	catch (error) {
		console.log("slide-stats: vibes failed: " + error);
	}
}

/* ------------------------------------------------------------------ */
/* Watch-phone sync                                                    */
/* ------------------------------------------------------------------ */

function setupMessage() {
	try {
		message = new Message({
			keys: ["Sync", "Ack", "Settings"],
			input: 1024,
			output: 1024,
			onReadable() {
				const msg = this.read();
				const ack = msg.get("Ack");
				if (ack)
					handleAck(ack);
				const incoming = msg.get("Settings");
				if (incoming)
					applySettings(incoming);
			},
			onWritable() {
				messageReady = true;
				flushOutbox();
			},
			onSuspend() {
				messageReady = false;
				sendingLift = false;
			},
		});
	}
	catch (error) {
		console.log("slide-stats: message setup failed: " + error);
	}
}

function handleAck(payload) {
	try {
		const data = JSON.parse(payload);
		if (data && data.id)
			store.ack(data.id);
	}
	catch (error) {
		console.log("slide-stats: bad ack: " + error);
	}
	sendingLift = false;
	if (ackTimer) {
		clearTimeout(ackTimer);
		ackTimer = null;
	}
	flushOutbox();
}

function flushOutbox() {
	if (!message || !messageReady || sendingLift)
		return;
	const queue = store.getOutbox();
	if (!queue.length)
		return;
	const record = queue[0];
	sendingLift = true;
	try {
		message.write(new Map([["Sync", JSON.stringify(record)]]));
		ackTimer = setTimeout(() => {
			sendingLift = false;
			ackTimer = null;
			flushOutbox();
		}, 15000);
	}
	catch (error) {
		sendingLift = false;
		console.log("slide-stats: sync write failed: " + error);
	}
}

function sendSettings() {
	if (!message || !messageReady)
		return;
	try {
		message.write(new Map([["Settings", JSON.stringify(store.getSettings())]]));
	}
	catch (error) {
		console.log("slide-stats: settings write failed: " + error);
	}
}

function applySettings(json) {
	try {
		const next = JSON.parse(json);
		store.setSettings(next);
		settings = store.getSettings();
		detector.setOptions(settings.detection);
		if (settings.paused)
			stopGps();
		else if (!isDayClosed())
			startGps();
		updateAll();
	}
	catch (error) {
		console.log("slide-stats: bad settings: " + error);
	}
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function setBase() {
	if (lastAltitude === null || !isFinite(lastAltitude)) {
		statusNoGps = true;
		draw();
		return;
	}
	store.setBase(lastAltitude);
	store.setPaused(false);
	settings = store.getSettings();
	sendSettings();
	detector.reset();
	onLift = false;
	lastProcessed = 0;
	lastPromptAltitude = null;
	if (!location)
		startGps();
	updateAll();
}

function togglePause() {
	const paused = !store.getSettings().paused;
	store.setPaused(paused);
	settings = store.getSettings();
	sendSettings();
	if (paused) {
		detector.reset();
		onLift = false;
		stopGps();
	}
	else {
		lastProcessed = 0;
		startGps();
	}
	updateAll();
}

function toggleDay() {
	if (isDayClosed()) {
		store.resumeDay();
		lastProcessed = 0;
		startGps();
	}
	else {
		store.endDay();
		detector.reset();
		onLift = false;
		stopGps();
	}
	updateAll();
}

function undoLastLift() {
	const removed = store.undoLastLift();
	if (removed) {
		updateAll();
		flushOutbox();
	}
}

function toggleUnits() {
	store.setSettings({ units: store.getSettings().units === "metric" ? "imperial" : "metric" });
	settings = store.getSettings();
	sendSettings();
	updateAll();
}

function toggleVibration() {
	store.setSettings({ vibration: !store.getSettings().vibration });
	settings = store.getSettings();
	sendSettings();
	updateAll();
}

function startMockLift() {
	if (!store.hasBase())
		store.setBase(2000);
	settings = store.getSettings();
	detector.reset();
	onLift = false;
	let altitude = 2000;
	let direction = 1;
	let timestamp = Date.now();
	statusNoGps = false;
	lastAltitude = altitude;
	if (mockTimer)
		clearInterval(mockTimer);
	mockTimer = setInterval(() => {
		timestamp += 1000;
		altitude += direction * 10;
		lastAltitude = altitude;
		if (altitude >= 2100)
			direction = -1;
		if (direction < 0 && altitude <= 2000) {
			clearInterval(mockTimer);
			mockTimer = null;
		}
		handleEvents(detector.addSample({
			t: timestamp,
			altitude,
			altitudeAccuracy: 5,
			speed: 4,
		}));
	}, 1000);
	draw();
}

function activateMenu() {
	const item = MENU[menuIndex];
	if (!item)
		return;
	switch (item.id) {
		case "base":
			setBase();
			closeMenu();
			break;
		case "day":
			toggleDay();
			closeMenu();
			break;
		case "pause":
			togglePause();
			closeMenu();
			break;
		case "undo":
			undoLastLift();
			closeMenu();
			break;
		case "units":
			toggleUnits();
			break;
		case "vibration":
			toggleVibration();
			break;
		case "sync":
			flushOutbox();
			closeMenu();
			break;
		case "about":
			showScreen("about");
			break;
		case "mock":
			startMockLift();
			closeMenu();
			break;
	}
}

function exitApp() {
	stopGps();
	if (mockTimer) {
		clearInterval(mockTimer);
		mockTimer = null;
	}
	if (message) {
		try {
			message.close();
		}
		catch (error) {}
		message = null;
	}
	watch.exit();
}

/* ------------------------------------------------------------------ */
/* Input and lifecycle                                                 */
/* ------------------------------------------------------------------ */

const SCREENS = ["main", "today", "season"];

function cycleScreen(delta) {
	if (currentScreen === "about") {
		showScreen("main");
		return;
	}
	const index = Math.max(0, SCREENS.indexOf(currentScreen));
	showScreen(SCREENS[(index + delta + SCREENS.length) % SCREENS.length]);
}

new Button({
	types: ["select", "up", "down", "back"],
	onPush(down, type) {
		if (!down)
			return;

		if (menuOpen) {
			if (type === "up") {
				menuIndex = (menuIndex + MENU.length - 1) % MENU.length;
				updateMenu();
			}
			else if (type === "down") {
				menuIndex = (menuIndex + 1) % MENU.length;
				updateMenu();
			}
			else if (type === "select")
				activateMenu();
			else if (type === "back")
				closeMenu();
			return;
		}

		if (type === "up") {
			cycleScreen(-1);
		}
		else if (type === "down") {
			cycleScreen(1);
		}
		else if (type === "select") {
			if (currentScreen === "main" && !store.hasBase() && lastAltitude !== null)
				setBase();
			else
				openMenu();
		}
		else if (type === "back") {
			if (currentScreen !== "main")
				showScreen("main");
			else
				exitApp();
		}
	},
});

watch.addEventListener("minutechange", () => {
	if (!menuOpen && currentScreen === "main")
		draw();
});

watch.addEventListener("daychange", () => {
	const result = store.ensureToday(true);
	if (result.changed) {
		detector.reset();
		onLift = false;
		lastProcessed = 0;
		updateAll();
	}
});

watch.addEventListener("didFocus", inFocus => {
	if (inFocus)
		updateAll();
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

setupMessage();
updateAll();

if (!settings.paused && !isDayClosed())
	startGps();
