import {} from "piu/MC";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Location from "embedded:sensor/Location";
import Message from "pebble/message";

import { createLiftDetector } from "./lib/detector.js";
import { createDayStore } from "./lib/day-store.js";
import * as Format from "./lib/format.js";

const VERSION = "0.1.0";
const DEBUG = true;
const PROCESS_MS = 10000;

const storage = {
	getItem: key => localStorage.getItem(key),
	setItem: (key, value) => localStorage.setItem(key, value),
};

let store = createDayStore({ storage }).load();
let settings = store.getSettings();
let detector = createLiftDetector(settings.detection);
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
let mockTimer = null;

let menuOpen = false;
let menuIndex = 0;
let currentScreen = "main";

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

const whiteSkin = new Skin({ fill: "white" });

const timeStyle = new Style({ font: "bold 42px Bitham", color: "black", horizontal: "center" });
const altitudeStyle = new Style({ font: "bold 28px Gothic", color: "black", horizontal: "center" });
const statsStyle = new Style({ font: "18px Gothic", color: "black", horizontal: "center" });
const statusStyle = new Style({ font: "14px Gothic", color: "black", horizontal: "center" });
const titleStyle = new Style({ font: "bold 18px Gothic", color: "black", horizontal: "center" });
const rowStyle = new Style({ font: "18px Gothic", color: "black" });
const rowValueStyle = new Style({ font: "bold 18px Gothic", color: "black", horizontal: "right" });
const menuStyle = new Style({ font: "14px Gothic", color: "black", horizontal: "center" });

const round = screen.round;
const side = round ? 40 : 0;
const mainTop = round ? 34 : 16;
const detailTop = round ? 34 : 14;
const menuTop = round ? 32 : 14;

const timeLabel = new Label(null, {
	left: 0, right: 0, top: 0, height: 52,
	style: timeStyle, string: "--:--",
});
const altitudeLabel = new Label(null, {
	left: 0, right: 0, top: 58, height: 34,
	style: altitudeStyle, string: "--",
});
const statsLabel = new Label(null, {
	left: 0, right: 0, top: 96, height: 26,
	style: statsStyle, string: "",
});
const statusLabel = new Label(null, {
	left: 0, right: 0, top: 128, height: 18,
	style: statusStyle, string: "",
});

const mainScreen = new Container(null, {
	left: side, right: side, top: mainTop, bottom: 0,
	contents: [timeLabel, altitudeLabel, statsLabel, statusLabel],
	visible: true,
});

const titleLabel = new Label(null, {
	left: 0, right: 0, top: 0, height: 24,
	style: titleStyle, string: "",
});

const detailRows = [];
for (let i = 0; i < 6; i++) {
	const left = new Label(null, { left: 0, width: 85, top: 0, height: 24, style: rowStyle, string: "" });
	const right = new Label(null, { right: 0, width: 95, top: 0, height: 24, style: rowValueStyle, string: "" });
	const row = new Container(null, {
		left: 0, right: 0, top: 30 + i * 24, height: 24,
		contents: [left, right],
	});
	detailRows.push({ row, left, right });
}
const detailScreen = new Container(null, {
	left: side, right: side, top: detailTop, bottom: 0,
	contents: [titleLabel].concat(detailRows.map(item => item.row)),
	visible: false,
});

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

const menuLabels = [];
for (let i = 0; i < MENU.length; i++) {
	menuLabels.push(new Label(null, {
		left: 10, right: 10, top: i * 18, height: 18,
		style: menuStyle, string: "",
	}));
}
const menuScreen = new Container(null, {
	left: side, right: side, top: menuTop, bottom: 0,
	contents: menuLabels,
	visible: false,
});

const application = new Application(null, {
	skin: whiteSkin,
	contents: [mainScreen, detailScreen, menuScreen],
});

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

function isDayClosed() {
	const today = store.getToday();
	return !!(today && today.closed);
}

function statusText() {
	if (settings.paused)
		return "PAUSED";
	if (isDayClosed())
		return "DAY ENDED";
	if (statusNoGps)
		return "NO GPS";
	if (onLift)
		return "LIFT";
	return "";
}

function updateMain() {
	const now = new Date();
	timeLabel.string = Format.formatTime(now, watch.hour12);
	statusLabel.string = statusText();

	const stats = store.todayStats();
	if (store.hasBase()) {
		altitudeLabel.string = Format.formatAltitude(lastAltitude, settings.units);
		const runs = stats.runs + (stats.runs === 1 ? " RUN  " : " RUNS  ");
		statsLabel.string = runs + Format.formatVertical(stats.vertical, settings.units);
	}
	else {
		altitudeLabel.string = "SET BASE";
		statsLabel.string = lastAltitude === null
			? "WAITING FOR GPS"
			: Format.formatAltitude(lastAltitude, settings.units) + "  SELECT";
	}
}

function setRows(rows) {
	for (let i = 0; i < detailRows.length; i++) {
		const row = detailRows[i];
		if (i < rows.length) {
			row.left.string = rows[i][0];
			row.right.string = rows[i][1];
			row.row.visible = true;
		}
		else {
			row.left.string = "";
			row.right.string = "";
			row.row.visible = false;
		}
	}
}

function updateDetail() {
	const stats = store.todayStats();
	const units = settings.units;
	if (currentScreen === "today") {
		titleLabel.string = "TODAY";
		setRows([
			["Vertical", Format.formatVertical(stats.vertical, units)],
			["Runs", String(stats.runs)],
			["First", stats.first ? Format.formatTime(new Date(stats.first), watch.hour12) : "--"],
			["Last", stats.last ? Format.formatTime(new Date(stats.last), watch.hour12) : "--"],
			["Average", Format.formatAverage(stats.average, units)],
			["Longest", Format.formatVertical(stats.longest, units)],
		]);
	}
	else if (currentScreen === "season") {
		const season = store.seasonSummary();
		titleLabel.string = "SEASON";
		setRows([
			["Season", season.label],
			["Days", String(season.days)],
			["Vertical", Format.formatVertical(season.vertical, units)],
			["Runs", String(season.runs)],
			["Avg / day", Format.formatAverage(season.averageVertical, units)],
			["Best day", season.bestDay ? Format.formatDateShort(season.bestDay.date) : "--"],
		]);
	}
	else if (currentScreen === "about") {
		titleLabel.string = "ABOUT";
		setRows([
			["Slide Stats", VERSION],
			["Platform", round ? "Gabbro" : "Emery"],
			["Units", units === "metric" ? "Metric" : "Imperial"],
			["Data", "Watch + phone"],
			["Stats", "Pebble app > Settings"],
			["Tracking", store.isTracking() ? "On" : "Off"],
		]);
	}
}

function updateMenu() {
	for (let i = 0; i < MENU.length; i++)
		menuLabels[i].string = (i === menuIndex ? "> " : "  ") + MENU[i].label();
}

function updateAll() {
	settings = store.getSettings();
	updateMain();
	if (!menuOpen && currentScreen !== "main")
		updateDetail();
	if (menuOpen)
		updateMenu();
}

function showScreen(name) {
	currentScreen = name;
	menuOpen = false;
	menuScreen.visible = false;
	if (name === "main") {
		mainScreen.visible = true;
		detailScreen.visible = false;
		updateMain();
	}
	else {
		mainScreen.visible = false;
		detailScreen.visible = true;
		updateDetail();
	}
}

function openMenu() {
	menuOpen = true;
	menuIndex = 0;
	mainScreen.visible = false;
	detailScreen.visible = false;
	menuScreen.visible = true;
	updateMenu();
}

function closeMenu() {
	menuOpen = false;
	menuScreen.visible = false;
	showScreen(currentScreen);
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
				updateMain();
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
	if (typeof altitude === "number" && isFinite(altitude)) {
		lastAltitude = smoothedAltitude(altitude);
		statusNoGps = false;
	}
	else {
		statusNoGps = true;
	}

	if (!store.hasBase() || settings.paused || isDayClosed()) {
		updateMain();
		return;
	}

	const now = Date.now();
	if (now - lastProcessed < PROCESS_MS)
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
			updateMain();
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
			updateMain();
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
		updateMain();
		return;
	}
	store.setBase(lastAltitude);
	store.setPaused(false);
	sendSettings();
	settings = store.getSettings();
	detector.reset();
	onLift = false;
	lastProcessed = 0;
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
	if (mockTimer)
		clearInterval(mockTimer);
	mockTimer = setInterval(() => {
		timestamp += 1000;
		altitude += direction * 2;
		if (altitude >= 2160)
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
	if (!location)
		startGps();
	updateAll();
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
			if (currentScreen === "main" && !store.hasBase())
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

watch.addEventListener("minutechange", updateMain);

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
showScreen("main");

if (!settings.paused && !isDayClosed())
	startGps();
