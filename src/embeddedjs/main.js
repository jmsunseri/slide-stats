import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Location from "embedded:sensor/Location";
import Message from "pebble/message";

import * as Core from "core";


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
const savedActive = store.getActiveLift();
if (savedActive)
	detector.restore(savedActive);
let location = null;
let message = null;
let messageReady = false;
let sendingLift = false;
let ackTimer = null;
let statusNoGps = false;
let lastProcessed = 0;

let menuOpen = false;
let menuIndex = 0;
let menuScroll = 0;
let currentScreen = "main";
let frameDay = null;
let frameSeason = null;

const history = { day: {}, season: {} };
let selectedDayKey = null;
let selectedSeasonKey = null;
let queryQueue = [];
let querying = false;
let activeQuery = null;
let queryTimer = null;

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const render = new Poco(screen);
const white = render.makeColor(255, 255, 255);
const black = render.makeColor(0, 0, 0);

let bgColor = white;
let accentColor = black;
let textColor = black;

function packColor(value, sameValue, sameColor) {
	if (typeof value !== "number" || value === sameValue)
		return sameColor;
	return render.makeColor((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

function updateTheme() {
	const theme = settings.theme || {};
	bgColor = packColor(theme.background, 0xffffff, white);
	accentColor = packColor(theme.accent, 0x000000, black);
	textColor = packColor(theme.text, 0x000000, black);
}

const W = render.width;
const H = render.height;
const ROUND = screen.round;
const MARGIN = ROUND ? 40 : 6;

// Native action-bar geometry from the Pebble firmware.
const BAR_W = ROUND ? 40 : 34;
const BAR_MARGIN = ROUND ? 80 : 45;
const BAR_LEFT = W - BAR_W;
const CONTENT_W = ROUND ? W : W - BAR_W;
const CONTENT_CENTER = ROUND ? (W >> 1) : (CONTENT_W >> 1);
const DETAIL_RIGHT = ROUND ? W - 50 : CONTENT_W - MARGIN;
const STATS_MAX = ROUND ? 180 : CONTENT_W - 12;
const MENU_LEFT = ROUND ? 55 : 0;
const MENU_WIDTH = ROUND ? 150 : CONTENT_W;

const fontTime = new render.Font("Roboto-Bold", 49);
const fontSuffix = new render.Font("Gothic-Bold", 14);
const fontStats = new render.Font("Gothic-Bold", 24);

const rowSize = contentSize === 0 ? 14 : 18;
const fontRow = new render.Font("Gothic-Regular", rowSize);
const fontRowBold = new render.Font("Gothic-Bold", rowSize);

function centeredX(text, font) {
	return CONTENT_CENTER - (render.getTextWidth(text, font) >> 1);
}

function drawCentered(text, font, y, color) {
	render.drawText(text, font, color === undefined ? textColor : color, centeredX(text, font), y);
}

function drawRight(text, font, right, y) {
	render.drawText(text, font, textColor, right - render.getTextWidth(text, font), y);
}

function drawPause(x, y) {
	render.fillRectangle(textColor, x, y, 4, 14);
	render.fillRectangle(textColor, x + 8, y, 4, 14);
}

function drawNoGps(x, y) {
	const cx = x + 8;
	const cy = y + 8;
	for (let angle = 0; angle < 6.283; angle += 0.2)
		render.drawPixel(textColor, Math.round(cx + Math.cos(angle) * 7), Math.round(cy + Math.sin(angle) * 7));
	for (let i = -5; i <= 5; i++) {
		render.drawPixel(textColor, cx + i, cy + i);
		render.drawPixel(textColor, cx + i + 1, cy + i);
	}
}

function drawTriangle(cx, baseY, half, height, color) {
	for (let i = 0; i < height; i++) {
		const w = Math.round(half * i / (height - 1));
		render.fillRectangle(color, cx - w, baseY - height + 1 + i, w * 2 + 1, 1);
	}
}

/** The two-peak mark from the app icon: taller left peak with a snow cap. */
function drawPeaks(cx, baseY, height) {
	const scale = height / 22;
	const leftHalf = Math.round(9 * scale);
	const rightHalf = Math.round(6.5 * scale);
	const rightHeight = Math.round(16 * scale);
	const leftCx = cx - Math.round(4 * scale);
	const rightCx = leftCx + Math.round(10.5 * scale);
	const topY = baseY - height + 1;

	drawTriangle(leftCx, baseY, leftHalf, height, textColor);

	const capTop = topY + Math.round(4 * scale);
	const capHeight = Math.round(8 * scale);
	const capHalf = Math.max(2, Math.round(3 * scale));
	const capBase = capTop + capHeight - 1;
	drawTriangle(leftCx, capBase, capHalf, capHeight, bgColor);
	const tooth = Math.max(1, Math.round(scale));
	const gap = Math.max(1, Math.round(capHalf * 0.4));
	render.fillRectangle(textColor, leftCx - gap, capBase - tooth - 1, tooth, tooth + 2);
	render.fillRectangle(textColor, leftCx + gap, capBase - tooth, tooth, tooth + 1);

	drawTriangle(rightCx, baseY, rightHalf, rightHeight, textColor);
	render.drawLine(rightCx, baseY - rightHeight + 1, rightCx - rightHalf, baseY, bgColor, 1);
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
	let x = CONTENT_CENTER - ((items.length === 1 ? 16 : 36) >> 1);
	for (const item of items) {
		if (item === "pause")
			drawPause(x, y);
		else
			drawNoGps(x, y);
		x += 19;
	}
}

function isDayClosed() {
	return store.isClosed();
}

function todayKey() {
	return store.todayDate() || Core.dayKey(new Date());
}

function yesterdayKey() {
	const date = new Date();
	date.setDate(date.getDate() - 1);
	return Core.dayKey(date);
}

function currentSeason() {
	return Core.currentSeasonKey(new Date(), settings);
}

function displayedDay() {
	if (!selectedDayKey)
		return null;
	if (selectedDayKey === todayKey()) {
		const stats = store.todayStats();
		const phone = history.day[selectedDayKey];
		return {
			date: selectedDayKey,
			vertical: stats.vertical,
			runs: stats.runs,
			first: stats.first,
			last: stats.last,
			longest: stats.longest,
			average: stats.average,
			older: phone ? phone.older : null,
			newer: phone ? phone.newer : null,
		};
	}
	return history.day[selectedDayKey] || null;
}

function displayedSeason() {
	if (!selectedSeasonKey)
		return null;
	return history.season[selectedSeasonKey] || null;
}

function dayTitle(key) {
	if (key === todayKey())
		return "TODAY";
	if (key === yesterdayKey())
		return "YESTERDAY";
	return Core.formatDateShort(key);
}

function drawMain() {
	drawPeaks(CONTENT_CENTER, ROUND ? 78 : 70, ROUND ? 48 : 44);

	const clock = Core.formatClock(new Date(), watch.hour12);
	const digitWidth = render.getTextWidth(clock.text, fontTime);
	const suffixWidth = clock.suffix ? render.getTextWidth(clock.suffix, fontSuffix) : 0;
	const gap = clock.suffix ? 4 : 0;
	const totalWidth = digitWidth + gap + suffixWidth;
	const x = CONTENT_CENTER - (totalWidth >> 1);
	const y = (H - fontTime.height) >> 1;

	render.drawText(clock.text, fontTime, textColor, x, y);
	if (clock.suffix) {
		const baseline = y + fontTime.ascent;
		render.drawText(clock.suffix, fontSuffix, textColor, x + digitWidth + gap,
			baseline - fontSuffix.ascent);
	}

	const stats = store.todayStats();
	const statsText = stats.runs + (stats.runs === 1 ? " RUN  " : " RUNS  ") +
		Core.formatVertical(stats.vertical, settings.units);
	let statsFont = fontStats;
	if (render.getTextWidth(statsText, statsFont) > STATS_MAX)
		statsFont = fontRowBold;
	drawCentered(statsText, statsFont, y + fontTime.height + 8);
	drawStatusIcons();
}

function detailData() {
	const units = settings.units;
	if (currentScreen === "season") {
		const season = frameSeason;
		const label = season ? season.label : Core.seasonLabel(selectedSeasonKey);
		return [label, [
			["Days", season ? String(season.days) : "--"],
			["Vertical", season ? Core.formatVertical(season.vertical, units) : "--"],
			["Runs", season ? String(season.runs) : "--"],
			["Avg / day", season ? Core.formatAverage(season.averageVertical, units) : "--"],
			["Best day", season && season.bestDay ? Core.formatDateShort(season.bestDay.date) : "--"],
		]];
	}
	const day = frameDay;
	const title = selectedDayKey ? dayTitle(selectedDayKey) : "TODAY";
	return [title, [
		["Vertical", day ? Core.formatVertical(day.vertical, units) : "--"],
		["Runs", day ? String(day.runs) : "--"],
		["First", day && day.first ? Core.formatTime(new Date(day.first), watch.hour12) : "--"],
		["Last", day && day.last ? Core.formatTime(new Date(day.last), watch.hour12) : "--"],
		["Average", day ? Core.formatAverage(day.average, units) : "--"],
		["Longest", day ? Core.formatVertical(day.longest, units) : "--"],
	]];
}

function drawDetail() {
	const data = detailData();
	const titleY = ROUND ? 34 : 12;
	drawCentered(data[0], fontRowBold, titleY);
	const top = titleY + fontRowBold.height + 10;
	const rowHeight = fontRow.height + 8;
	for (let i = 0; i < data[1].length; i++) {
		const y = top + i * rowHeight;
		render.drawText(data[1][i][0], fontRow, textColor, MARGIN, y);
		drawRight(data[1][i][1], fontRowBold, DETAIL_RIGHT, y);
	}
}

function drawChevron(cx, cy, up) {
	for (let i = 0; i < 5; i++) {
		const half = up ? i : 4 - i;
		render.fillRectangle(textColor, cx - half, cy + i, half * 2 + 1, 1);
	}
}

function drawMenu() {
	const top = ROUND ? 26 : 2;
	const left = MENU_LEFT;
	const width = MENU_WIDTH;
	const rowHeight = fontRow.height + 10;
	const listTop = top + 8;
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
		const selected = index === menuIndex;
		if (selected)
			render.fillRectangle(textColor, left + 2, y + 1, 3, fontRow.height - 2);
		render.drawText(menuLabel(MENU[index]), selected ? fontRowBold : fontRow, textColor, left + 12, y);
	}

	if (menuScroll > 0)
		drawChevron(left + (width >> 1), top + 2, true);
	if (menuScroll + visible < MENU.length)
		drawChevron(left + (width >> 1), H - 9, false);
}

/* ------------------------------------------------------------------ */
/* Action bar                                                          */
/* ------------------------------------------------------------------ */

function drawBarMountain(cx, cy) {
	// Taller left peak, shorter right peak, no bottom border.
	for (let y = cy - 7; y <= cy + 7; y++) {
		const t = (y - (cy - 7)) / 14;
		const left = Math.round(cx - 4 - 4 * t);
		const right = Math.round(cx - 4 + 6 * t);
		render.fillRectangle(white, left, y, right - left + 1, 1);
	}
	for (let y = cy - 2; y <= cy + 7; y++) {
		const t = (y - (cy - 2)) / 9;
		const left = Math.round(cx + 5 - 3 * t);
		const right = Math.round(cx + 5 + 3 * t);
		render.fillRectangle(white, left, y, right - left + 1, 1);
	}
	// Bar-coloured separator where the right peak crosses the left.
	for (let y = cy - 2; y <= cy + 7; y++) {
		const t = (y - (cy - 2)) / 9;
		render.drawPixel(accentColor, Math.round(cx + 5 - 3 * t), y);
	}
}

function drawBarCalendar(cx, cy) {
	render.fillRectangle(white, cx - 7, cy - 5, 14, 12);
	render.fillRectangle(accentColor, cx - 7, cy - 2, 14, 1);
	render.fillRectangle(accentColor, cx - 4, cy - 5, 1, 3);
	render.fillRectangle(accentColor, cx + 3, cy - 5, 1, 3);
	render.fillRectangle(accentColor, cx - 1, cy + 2, 2, 2);
}

function drawBarSeason(cx, cy) {
	// Back page.
	render.fillRectangle(white, cx - 7, cy - 6, 12, 10);
	render.fillRectangle(accentColor, cx - 7, cy - 3, 12, 1);
	// Front page with a bar-coloured outline so it separates from the back page.
	render.fillRectangle(accentColor, cx - 3, cy - 2, 12, 10);
	render.fillRectangle(white, cx - 2, cy - 1, 10, 8);
	render.fillRectangle(accentColor, cx - 2, cy + 1, 10, 1);
	render.fillRectangle(accentColor, cx + 2, cy + 4, 2, 2);
}

function drawBarMore(cx, cy) {
	render.fillRectangle(white, cx - 1, cy - 5, 2, 2);
	render.fillRectangle(white, cx - 1, cy - 1, 2, 2);
	render.fillRectangle(white, cx - 1, cy + 3, 2, 2);
}

function drawBarLine(x0, y0, x1, y1) {
	const dx = Math.abs(x1 - x0);
	const sx = x0 < x1 ? 1 : -1;
	const dy = -Math.abs(y1 - y0);
	const sy = y0 < y1 ? 1 : -1;
	let error = dx + dy;
	while (true) {
		render.fillRectangle(white, x0, y0, 2, 2);
		if (x0 === x1 && y0 === y1)
			break;
		const twice = 2 * error;
		if (twice >= dy) {
			error += dy;
			x0 += sx;
		}
		if (twice <= dx) {
			error += dx;
			y0 += sy;
		}
	}
}

function drawBarChevron(cx, cy, up) {
	if (up) {
		drawBarLine(cx - 5, cy + 2, cx, cy - 3);
		drawBarLine(cx, cy - 3, cx + 5, cy + 2);
	}
	else {
		drawBarLine(cx - 5, cy - 2, cx, cy + 3);
		drawBarLine(cx, cy + 3, cx + 5, cy - 2);
	}
}

function drawBarCheck(cx, cy) {
	drawBarLine(cx - 5, cy, cx - 1, cy + 4);
	drawBarLine(cx - 1, cy + 4, cx + 5, cy - 4);
}

function drawBarIcon(name, cx, cy) {
	if (!name)
		return;
	if (name === "mountain")
		drawBarMountain(cx, cy);
	else if (name === "today")
		drawBarCalendar(cx, cy);
	else if (name === "season")
		drawBarSeason(cx, cy);
	else if (name === "more")
		drawBarMore(cx, cy);
	else if (name === "up")
		drawBarChevron(cx, cy, true);
	else if (name === "down")
		drawBarChevron(cx, cy, false);
	else if (name === "check")
		drawBarCheck(cx, cy);
}

function drawActionBar() {
	if (ROUND) {
		const diameter = H * 19 / 9;
		const radius = diameter / 2;
		const cx = BAR_LEFT + radius;
		const cy = H / 2;
		for (let y = 0; y < H; y++) {
			const dy = y - cy;
			const left = cx - Math.sqrt(radius * radius - dy * dy);
			const start = Math.max(BAR_LEFT, Math.ceil(left));
			if (start < W)
				render.fillRectangle(accentColor, start, y, W - start, 1);
		}
	}
	else {
		render.fillRectangle(accentColor, BAR_LEFT, 0, BAR_W, H);
	}

	let icons;
	if (menuOpen)
		icons = ["up", "check", "down"];
	else if (currentScreen === "main")
		icons = ["season", "more", "today"];
	else if (currentScreen === "today") {
		const day = frameDay;
		icons = [day && day.older ? "up" : null, null, day && day.newer ? "down" : null];
	}
	else {
		const season = frameSeason;
		icons = [season && season.older ? "up" : null, null, season && season.newer ? "down" : null];
	}
	const cx = BAR_LEFT + (BAR_W >> 1) - (ROUND ? 2 : 0);
	drawBarIcon(icons[0], cx, BAR_MARGIN + 9);
	drawBarIcon(icons[1], cx, H >> 1);
	drawBarIcon(icons[2], cx, H - BAR_MARGIN - 9);
}

function draw() {
	frameDay = currentScreen === "today" ? displayedDay() : null;
	frameSeason = currentScreen === "season" ? displayedSeason() : null;
	render.begin();
	render.fillRectangle(bgColor, 0, 0, W, H);
	drawActionBar();
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

const MENU = ["day", "pause", "undo", "units", "vibration", "sync"];

function menuLabel(id) {
	if (id === "day")
		return isDayClosed() ? "Resume Day" : "End Day";
	if (id === "pause")
		return settings.paused ? "Resume" : "Pause";
	if (id === "units")
		return "Units: " + (settings.units === "metric" ? "Metric" : "Imperial");
	if (id === "vibration")
		return "Vibration: " + (settings.vibration ? "On" : "Off");
	return id === "undo" ? "Undo Last Lift" : "Sync Now";
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function updateAll(nextSettings) {
	settings = nextSettings || store.getSettings();
	draw();
}

function showScreen(name) {
	currentScreen = name;
	menuOpen = false;
	queryQueue.length = 0;
	if (name === "today") {
		selectedDayKey = todayKey();
		queueSummary("day", selectedDayKey);
	}
	else if (name === "season") {
		selectedSeasonKey = currentSeason();
		queueSummary("season", selectedSeasonKey);
	}
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
		latitude: sample.latitude,
		longitude: sample.longitude,
	}));
	store.setActiveLift(detector.snapshot());
}

function handleEvents(events) {
	for (const event of events) {
		if (event.type === "start") {
			console.log("slide-stats: lift start");
			vibrate("start");
		}
		else if (event.type === "end") {
			store.addLift(event.lift);
			console.log("slide-stats: lift end " + Math.round(event.lift.gain) + " m");
			vibrate("end");
			lastProcessed = 0;
			updateAll(settings);
			flushOutbox();
		}
	}
}

// Mirrored rhythms: accelerating when a lift starts, decelerating when it ends.
const VIBE_START = [100, 80, 160, 80, 240];
const VIBE_END = [240, 80, 160, 80, 100];

function vibrate(kind) {
	if (!settings.vibration)
		return;
	try {
		Vibes.pattern(kind === "end" ? VIBE_END : VIBE_START);
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
			keys: ["Sync", "Ack", "Settings", "Query", "Data", "Purge"],
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
				const data = msg.get("Data");
				if (data)
					handleData(data);
				const purge = msg.get("Purge");
				if (purge)
					handlePurge(purge);
			},
			onWritable() {
				messageReady = true;
				flushOutbox();
				ensureScreenSummary();
				flushQuery();
			},
			onSuspend() {
				messageReady = false;
				sendingLift = false;
				queryQueue.length = 0;
				querying = false;
				activeQuery = null;
				if (queryTimer) {
					clearTimeout(queryTimer);
					queryTimer = null;
				}
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
	flushQuery();
}

function flushOutbox() {
	if (!message || !messageReady || sendingLift)
		return;
	const record = store.peekOutbox();
	if (!record)
		return;
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

function queueSummary(kind, key) {
	if (!key || history[kind][key])
		return;
	if (activeQuery && activeQuery.kind === kind && activeQuery.key === key)
		return;
	for (const item of queryQueue) {
		if (item.kind === kind && item.key === key)
			return;
	}
	if (queryQueue.length >= 6)
		return;
	queryQueue.push({ kind, key });
	flushQuery();
}

function ensureScreenSummary() {
	if (currentScreen === "today" && selectedDayKey && !history.day[selectedDayKey])
		queueSummary("day", selectedDayKey);
	else if (currentScreen === "season" && selectedSeasonKey && !history.season[selectedSeasonKey])
		queueSummary("season", selectedSeasonKey);
}

function prefetch(kind, summary) {
	if (!summary)
		return;
	if (summary.older)
		queueSummary(kind, summary.older);
	if (summary.newer)
		queueSummary(kind, summary.newer);
}

function remember(kind, key, summary) {
	history[kind][key] = summary;
	const keys = Object.keys(history[kind]);
	if (keys.length <= 6)
		return;
	const selected = kind === "day" ? selectedDayKey : selectedSeasonKey;
	for (const old of keys) {
		if (old !== key && old !== selected) {
			delete history[kind][old];
			break;
		}
	}
}

function flushQuery() {
	if (!message || !messageReady || querying || sendingLift || !queryQueue.length)
		return;
	activeQuery = queryQueue.shift();
	querying = true;
	try {
		message.write(new Map([["Query", JSON.stringify({ v: 1, kind: activeQuery.kind, key: activeQuery.key })]]));
		queryTimer = setTimeout(() => {
			querying = false;
			if (activeQuery)
				queryQueue.unshift(activeQuery);
			activeQuery = null;
			queryTimer = null;
			flushQuery();
		}, 8000);
	}
	catch (error) {
		querying = false;
		queryQueue.unshift(activeQuery);
		activeQuery = null;
		console.log("slide-stats: query write failed: " + error);
	}
}

function handlePurge(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad purge: " + error);
		return;
	}
	if (!data || !data.date)
		return;
	if (store.purgeDay(data.date)) {
		detector.reset();
		lastProcessed = 0;
		updateAll(settings);
	}
}

function handleData(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad history data: " + error);
		return;
	}
	if (!data || !data.kind || !data.key || !data.summary)
		return;
	remember(data.kind, data.key, data.summary);
	if (queryTimer) {
		clearTimeout(queryTimer);
		queryTimer = null;
	}
	querying = false;
	activeQuery = null;
	const selected = (data.kind === "day" && selectedDayKey === data.key) ||
		(data.kind === "season" && selectedSeasonKey === data.key);
	if (selected) {
		prefetch(data.kind, data.summary);
		draw();
	}
	flushQuery();
}

function sendSettings(nextSettings) {
	if (!message || !messageReady)
		return;
	try {
		message.write(new Map([["Settings", JSON.stringify(nextSettings || store.getSettings())]]));
	}
	catch (error) {
		console.log("slide-stats: settings write failed: " + error);
	}
}

function applySettings(json) {
	try {
		const next = JSON.parse(json);
		settings = store.setSettings(next);
		updateTheme();
		detector.setOptions(settings.detection);
		history.day = {};
		history.season = {};
		queryQueue.length = 0;
		if (currentScreen === "season") {
			selectedSeasonKey = currentSeason();
			queueSummary("season", selectedSeasonKey);
		}
		else if (currentScreen === "today" && selectedDayKey && selectedDayKey !== todayKey()) {
			queueSummary("day", selectedDayKey);
		}
		if (settings.paused || isDayClosed()) {
			detector.reset();
			store.setActiveLift(null);
			stopGps();
		}
		else
			startGps();
		updateAll(settings);
	}
	catch (error) {
		console.log("slide-stats: bad settings: " + error);
	}
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function togglePause() {
	const paused = !settings.paused;
	settings = store.setPaused(paused);
	sendSettings(settings);
	if (paused) {
		detector.reset();
		store.setActiveLift(null);
		stopGps();
	}
	else {
		lastProcessed = 0;
		startGps();
	}
	updateAll(settings);
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
	updateAll(settings);
}

function undoLastLift() {
	const removed = store.undoLastLift();
	if (removed) {
		updateAll(settings);
		flushOutbox();
	}
}

function toggleUnits() {
	const units = settings.units === "metric" ? "imperial" : "metric";
	settings = store.setSettings({ units });
	sendSettings(settings);
	updateAll(settings);
}

function toggleVibration() {
	settings = store.setSettings({ vibration: !settings.vibration });
	sendSettings(settings);
	updateAll(settings);
}

function activateMenu() {
	const item = MENU[menuIndex];
	if (!item)
		return;
	switch (item) {
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
	}
}

function exitApp() {
	stopGps();
	if (message) {
		try {
			message.close();
		}
		catch (error) {}
		message = null;
	}
	store.save();
	watch.exit();
}

/* ------------------------------------------------------------------ */
/* Input and lifecycle                                                 */
/* ------------------------------------------------------------------ */

function stepDay(delta) {
	const day = displayedDay();
	if (!day) {
		queueSummary("day", selectedDayKey);
		return;
	}
	const target = delta < 0 ? day.older : day.newer;
	if (!target)
		return;
	selectedDayKey = target;
	const cached = history.day[target];
	if (cached)
		prefetch("day", cached);
	else
		queueSummary("day", target);
	draw();
}

function stepSeason(delta) {
	const season = displayedSeason();
	if (!season) {
		queueSummary("season", selectedSeasonKey);
		return;
	}
	const target = delta < 0 ? season.older : season.newer;
	if (!target)
		return;
	selectedSeasonKey = target;
	const cached = history.season[target];
	if (cached)
		prefetch("season", cached);
	else
		queueSummary("season", target);
	draw();
}

const SCREENS = ["main", "today", "season"];

function cycleScreen(delta) {
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

		if (type === "up") {
			if (currentScreen === "main")
				cycleScreen(-1);
			else if (currentScreen === "today")
				stepDay(-1);
			else if (currentScreen === "season")
				stepSeason(-1);
		}
		else if (type === "down") {
			if (currentScreen === "main")
				cycleScreen(1);
			else if (currentScreen === "today")
				stepDay(1);
			else if (currentScreen === "season")
				stepSeason(1);
		}
		else if (type === "select") {
			if (currentScreen === "main")
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
	const result = store.ensureToday();
	if (result.changed) {
		detector.reset();
		store.setActiveLift(null);
		lastProcessed = 0;
		updateAll(settings);
	}
});

watch.addEventListener("didFocus", inFocus => {
	if (inFocus) {
		ensureScreenSummary();
		updateAll(settings);
	}
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

updateTheme();
setupMessage();
updateAll(settings);

if (!settings.paused && !isDayClosed())
	startGps();
