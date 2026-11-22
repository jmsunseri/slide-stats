import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Location from "embedded:sensor/Location";
import Message from "pebble/message";

import * as Core from "core";

const VERSION = "0.1.0";
const DEBUG = true;

// The system Text Size preference. The FFI shim returns 0..3; default to Large.
let contentSize = 2;
try {
	if (typeof Natives !== "undefined" && Natives.slide_content_size)
		contentSize = Natives.slide_content_size();
}
catch (error) {
	console.log("slide-stats: content size unavailable: " + error);
}

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
let statusNoGps = false;
let lastProcessed = 0;
let mockTimer = null;

let menuOpen = false;
let menuIndex = 0;
let menuScroll = 0;
let currentScreen = "main";

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const render = new Poco(screen);
const white = render.makeColor(255, 255, 255);
const black = render.makeColor(0, 0, 0);

const W = render.width;
const H = render.height;
const ROUND = screen.round;
const MARGIN = ROUND ? 40 : 6;
const MENU_MARGIN = ROUND ? 55 : 0;

const fontTime = new render.Font("Roboto-Bold", 49);
const fontSuffix = new render.Font("Gothic-Bold", 18);
const fontStats = new render.Font("Gothic-Bold", 24);
const fontStatsSmall = new render.Font("Gothic-Bold", 18);

const menuSize = contentSize === 0 ? 14 : (contentSize >= 3 && !ROUND ? 24 : 18);
const fontMenu = new render.Font("Gothic-Regular", menuSize);
const fontMenuHeader = new render.Font("Gothic-Bold", menuSize);
const detailSize = contentSize === 0 ? 14 : 18;
const fontTitle = new render.Font("Gothic-Bold", detailSize);
const fontRow = new render.Font("Gothic-Regular", detailSize);
const fontRowBold = new render.Font("Gothic-Bold", detailSize);

function centeredX(text, font) {
	return (W - render.getTextWidth(text, font)) >> 1;
}

function drawCentered(text, font, y, color) {
	render.drawText(text, font, color === undefined ? black : color, centeredX(text, font), y);
}

function drawRight(text, font, right, y) {
	render.drawText(text, font, black, right - render.getTextWidth(text, font), y);
}

function drawPause(x, y) {
	render.fillRectangle(black, x, y, 4, 14);
	render.fillRectangle(black, x + 8, y, 4, 14);
}

function drawNoGps(x, y) {
	const cx = x + 8;
	const cy = y + 8;
	for (let angle = 0; angle < 6.283; angle += 0.2)
		render.drawPixel(black, Math.round(cx + Math.cos(angle) * 7), Math.round(cy + Math.sin(angle) * 7));
	for (let i = -5; i <= 5; i++) {
		render.drawPixel(black, cx + i, cy + i);
		render.drawPixel(black, cx + i + 1, cy + i);
	}
}

function drawStatusIcons() {
	if (!settings.paused && !statusNoGps)
		return;
	const y = H - (ROUND ? 42 : 32);
	const items = [];
	if (settings.paused)
		items.push("pause");
	if (statusNoGps)
		items.push("gps");
	let x = (W - (items.length === 1 ? 16 : 36)) >> 1;
	for (const item of items) {
		if (item === "pause")
			drawPause(x, y);
		else
			drawNoGps(x, y);
		x += 19;
	}
}

function isDayClosed() {
	const today = store.getToday();
	return !!(today && today.closed);
}

function drawMain() {
	const clock = Core.formatClock(new Date(), watch.hour12);
	const digitWidth = render.getTextWidth(clock.text, fontTime);
	const suffixWidth = clock.suffix ? render.getTextWidth(clock.suffix, fontSuffix) : 0;
	const gap = clock.suffix ? 4 : 0;
	const totalWidth = digitWidth + gap + suffixWidth;
	const x = (W - totalWidth) >> 1;
	const y = (H - fontTime.height) >> 1;

	render.drawText(clock.text, fontTime, black, x, y);
	if (clock.suffix) {
		const baseline = y + fontTime.ascent;
		render.drawText(clock.suffix, fontSuffix, black, x + digitWidth + gap,
			baseline - fontSuffix.ascent);
	}

	const stats = store.todayStats();
	const statsText = stats.runs + (stats.runs === 1 ? " RUN  " : " RUNS  ") +
		Core.formatVertical(stats.vertical, settings.units);
	let statsFont = fontStats;
	if (render.getTextWidth(statsText, statsFont) > W - 12)
		statsFont = fontStatsSmall;
	drawCentered(statsText, statsFont, y + fontTime.height + 8);
	drawStatusIcons();
}

function detailData() {
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
		["Stats", "Phone settings"],
		["Tracking", store.isTracking() ? "On" : "Off"],
	]];
}

function drawDetail() {
	const data = detailData();
	const titleY = ROUND ? 34 : 12;
	drawCentered(data[0], fontTitle, titleY);
	const top = titleY + fontTitle.height + 10;
	const rowHeight = fontRow.height + 8;
	for (let i = 0; i < data[1].length; i++) {
		const y = top + i * rowHeight;
		render.drawText(data[1][i][0], fontRow, black, MARGIN, y);
		drawRight(data[1][i][1], fontRowBold, W - MARGIN, y);
	}
}

function drawChevron(cx, cy, up, color) {
	const fill = color === undefined ? black : color;
	for (let i = 0; i < 5; i++) {
		const half = up ? i : 4 - i;
		render.fillRectangle(fill, cx - half, cy + i, half * 2 + 1, 1);
	}
}

function drawMenu() {
	const headerHeight = fontMenuHeader.height + 10;
	const top = ROUND ? 26 : 0;
	const left = MENU_MARGIN;
	const width = W - left * 2;

	render.fillRectangle(black, left, top, width, headerHeight);
	drawCentered("MORE", fontMenuHeader, top + 5, white);

	const rowHeight = fontMenu.height + 10;
	const listTop = top + headerHeight + 4;
	const listBottom = H - 14;
	let visible = Math.floor((listBottom - listTop) / rowHeight);
	if (visible < 3)
		visible = 3;

	if (menuIndex < menuScroll)
		menuScroll = menuIndex;
	else if (menuIndex >= menuScroll + visible)
		menuScroll = menuIndex - visible + 1;

	for (let i = 0; i < visible && menuScroll + i < MENU.length; i++) {
		const index = menuScroll + i;
		const y = listTop + i * rowHeight;
		if (index === menuIndex) {
			render.fillRectangle(black, left, y - 2, width, rowHeight - 2);
			render.drawText(MENU[index].label(), fontMenu, white, left + 10, y);
		}
		else {
			render.drawText(MENU[index].label(), fontMenu, black, left + 10, y);
		}
	}

	if (menuScroll > 0)
		drawChevron(W - MENU_MARGIN - 14, top + 10, true, white);
	if (menuScroll + visible < MENU.length)
		drawChevron(W >> 1, H - 9, false);
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
	menuScroll = 0;
	draw();
}

function closeMenu() {
	menuOpen = false;
	draw();
}

/* ------------------------------------------------------------------ */
/* GPS and detection                                                   */
/* ------------------------------------------------------------------ */

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
	if (typeof altitude !== "number" || !isFinite(altitude)) {
		if (!statusNoGps) {
			statusNoGps = true;
			draw();
		}
		return;
	}
	if (statusNoGps) {
		statusNoGps = false;
		draw();
	}

	if (settings.paused || isDayClosed())
		return;

	const now = Date.now();
	const interval = settings.sampleIntervalMs || 10000;
	if (now - lastProcessed < interval)
		return;
	lastProcessed = now;

	handleEvents(detector.addSample({
		t: now,
		altitude,
		altitudeAccuracy: sample.altitudeAccuracy,
		speed: sample.speed,
	}));
}

function handleEvents(events) {
	for (const event of events) {
		if (event.type === "start") {
			console.log("slide-stats: lift start");
			vibrate();
		}
		else if (event.type === "end") {
			store.addLift(event.lift);
			console.log("slide-stats: lift end " + Math.round(event.lift.gain) + " m");
			vibrate();
			lastProcessed = 0;
			updateAll();
			flushOutbox();
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
		if (settings.paused || isDayClosed())
			stopGps();
		else
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

function togglePause() {
	const paused = !store.getSettings().paused;
	store.setPaused(paused);
	settings = store.getSettings();
	sendSettings();
	if (paused) {
		detector.reset();
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
	if (isDayClosed())
		store.resumeDay();
	store.setPaused(false);
	settings = store.getSettings();
	detector.reset();
	statusNoGps = false;
	let altitude = 2000;
	let direction = 1;
	let timestamp = Date.now();
	if (mockTimer)
		clearInterval(mockTimer);
	mockTimer = setInterval(() => {
		timestamp += 1000;
		altitude += direction * 10;
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
	if (!location)
		startGps();
	updateAll();
}

function activateMenu() {
	const item = MENU[menuIndex];
	if (!item)
		return;
	switch (item.id) {
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
				draw();
			}
			else if (type === "down") {
				menuIndex = (menuIndex + 1) % MENU.length;
				draw();
			}
			else if (type === "select")
				activateMenu();
			else if (type === "back")
				closeMenu();
			return;
		}

		if (type === "up")
			cycleScreen(-1);
		else if (type === "down")
			cycleScreen(1);
		else if (type === "select")
			openMenu();
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
	const result = store.ensureToday();
	if (result.changed) {
		detector.reset();
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
