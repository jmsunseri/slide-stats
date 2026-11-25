import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Message from "pebble/message";

import * as Fmt from "format";


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
	removeItem: key => localStorage.removeItem(key),
};

const PHONE_KEY = "ss.phone";
const MESSAGE_KEYS = ["Sync", "Ack", "Settings", "Query", "Data", "Purge", "State", "Command", "Event"];

const DISPLAY_DEFAULTS = {
	units: "metric",
	vibration: true,
	paused: false,
	closed: false,
	seasonMode: "north",
	// Pebble's second-darkest blue: GColorDukeBlue (#0000AA).
	theme: { background: 0xffffff, accent: 0x0000aa, text: 0x000000 },
};

let phoneState = null;
let settings = Object.assign({}, DISPLAY_DEFAULTS);
let statusNoGps = true;

let message = null;
let messageReady = false;
let commandQueue = [];
let lastRefreshAt = 0;

let actionMenu = false;
let actionMenuTimer = null;
let menuRedrawTimer = null;
let lastMenuCloseAt = 0;
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
		render.fillRectangle(textColor, Math.round(cx + Math.cos(angle) * 7), Math.round(cy + Math.sin(angle) * 7), 1, 1);
	for (let i = -5; i <= 5; i++) {
		render.fillRectangle(textColor, cx + i, cy + i, 2, 1);
	}
}

function drawTriangle(cx, baseY, half, height, color) {
	for (let i = 0; i < height; i++) {
		const w = Math.round(half * i / (height - 1));
		render.fillRectangle(color, cx - w, baseY - height + 1 + i, w * 2 + 1, 1);
	}
}

/** Snow cap for a peak: a white triangle with two black teeth along its base. */
function drawSnowCap(cx, topY, height, half, scale) {
	const capTop = topY + Math.round(height * 0.18);
	const capHeight = Math.max(3, Math.round(height * 0.36));
	const capHalf = Math.max(2, Math.round(half * 0.35));
	const capBase = capTop + capHeight - 1;
	drawTriangle(cx, capBase, capHalf, capHeight, bgColor);
	const tooth = Math.max(1, Math.round(scale));
	const gap = Math.max(1, Math.round(capHalf * 0.4));
	render.fillRectangle(textColor, cx - gap, capBase - tooth - 1, tooth, tooth + 2);
	render.fillRectangle(textColor, cx + gap, capBase - tooth, tooth, tooth + 1);
}

/**
 * Four-peak mark for the main face: a small left peak, the original tall left
 * peak, the original short right peak, and a big snow-capped back peak on the
 * right. The back peaks are drawn first so the front pair overlaps them.
 */
function drawPeaks(cx, baseY, height) {
	const scale = height / 22;
	const smallCx = cx - Math.round(19.5 * scale);
	const leftCx = cx - Math.round(9.5 * scale);
	const rightCx = cx + Math.round(scale);
	const bigCx = cx + Math.round(14.5 * scale);

	const smallHeight = Math.round(12 * scale);		// 75% of the right peak
	const smallHalf = Math.round(5 * scale);
	const leftHeight = height;
	const leftHalf = Math.round(9 * scale);
	const rightHeight = Math.round(16 * scale);
	const rightHalf = Math.round(6.5 * scale);
	const bigHeight = Math.round(30 * scale);
	const bigHalf = Math.round(10 * scale);

	drawTriangle(bigCx, baseY, bigHalf, bigHeight, textColor);
	drawSnowCap(bigCx, baseY - bigHeight + 1, bigHeight, bigHalf, scale);

	drawTriangle(leftCx, baseY, leftHalf, leftHeight, textColor);
	drawSnowCap(leftCx, baseY - leftHeight + 1, leftHeight, leftHalf, scale);

	// The small left peak sits in front of the tall left peak.
	drawTriangle(smallCx, baseY, smallHalf, smallHeight, textColor);
	render.drawLine(smallCx, baseY - smallHeight + 1, smallCx + smallHalf, baseY, bgColor, 1);

	// The small right peak sits in front of both the tall left peak and the big
	// right peak, so it gets a separator line on each side.
	drawTriangle(rightCx, baseY, rightHalf, rightHeight, textColor);
	render.drawLine(rightCx, baseY - rightHeight + 1, rightCx - rightHalf, baseY, bgColor, 1);
	render.drawLine(rightCx, baseY - rightHeight + 1, rightCx + rightHalf, baseY, bgColor, 1);
}

function drawStatusIcons() {
	const gps = !settings.paused && !isDayClosed() && statusNoGps;
	if (!settings.paused && !gps)
		return;
	const y = H - (ROUND ? 42 : 32);
	const x = CONTENT_CENTER - 8;
	if (settings.paused)
		drawPause(x, y);
	else
		drawNoGps(x, y);
}

function isDayClosed() {
	return !!settings.closed;
}

function todayKey() {
	return phoneState ? phoneState.today.date : Fmt.dayKey(new Date());
}

function yesterdayKey() {
	const date = new Date();
	date.setDate(date.getDate() - 1);
	return Fmt.dayKey(date);
}

function currentSeason() {
	return phoneState ? phoneState.season.key : Fmt.currentSeasonKey(new Date(), settings);
}

function displayedDay() {
	if (!selectedDayKey)
		return null;
	if (phoneState && selectedDayKey === phoneState.today.date)
		return phoneState.today;
	return history.day[selectedDayKey] || null;
}

function displayedSeason() {
	if (!selectedSeasonKey)
		return null;
	if (phoneState && selectedSeasonKey === phoneState.season.key)
		return phoneState.season;
	return history.season[selectedSeasonKey] || null;
}

function dayTitle(key) {
	if (key === todayKey())
		return "TODAY";
	if (key === yesterdayKey())
		return "YESTERDAY";
	return Fmt.formatDateShort(key);
}

function drawMain() {
	drawPeaks(CONTENT_CENTER, ROUND ? 78 : 70, ROUND ? 48 : 44);

	const clock = Fmt.formatClock(new Date(), watch.hour12);
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

	const today = phoneState ? phoneState.today : null;
	const runs = today ? today.runs : 0;
	const vertical = today ? today.vertical : 0;
	const statsText = runs + (runs === 1 ? " RUN  " : " RUNS  ") +
		Fmt.formatVertical(vertical, settings.units);
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
		const label = season ? season.label : Fmt.seasonLabel(selectedSeasonKey);
		return [label, [
			["Days", season ? String(season.days) : "--"],
			["Vertical", season ? Fmt.formatVertical(season.vertical, units) : "--"],
			["Runs", season ? String(season.runs) : "--"],
			["Avg / day", season ? Fmt.formatAverage(season.averageVertical, units) : "--"],
			["Best day", season && season.bestDay ? Fmt.formatDateShort(season.bestDay.date) : "--"],
		]];
	}
	const day = frameDay;
	const title = selectedDayKey ? dayTitle(selectedDayKey) : "TODAY";
	return [title, [
		["Vertical", day ? Fmt.formatVertical(day.vertical, units) : "--"],
		["Runs", day ? String(day.runs) : "--"],
		["First", day && day.first ? Fmt.formatTime(new Date(day.first), watch.hour12) : "--"],
		["Last", day && day.last ? Fmt.formatTime(new Date(day.last), watch.hour12) : "--"],
		["Average", day ? Fmt.formatAverage(day.average, units) : "--"],
		["Longest", day ? Fmt.formatVertical(day.longest, units) : "--"],
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
	if (currentScreen === "main")
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
	if (currentScreen === "main")
		drawMain();
	else
		drawDetail();
	render.end();
}

/* ------------------------------------------------------------------ */
/* Phone state cache                                                   */
/* ------------------------------------------------------------------ */

function applyPhoneSettings(source) {
	source = source || {};
	const theme = Object.assign({}, DISPLAY_DEFAULTS.theme,
		source.theme && typeof source.theme === "object" ? source.theme : {});
	settings = {
		units: source.units === "imperial" ? "imperial" : "metric",
		vibration: source.vibration !== false,
		paused: !!source.paused,
		closed: !!source.closed,
		seasonMode: source.seasonMode === "south" ? "south" : "north",
		theme,
	};
}

function updateLocalSettings(patch) {
	const next = Object.assign({}, settings, patch);
	if (phoneState)
		phoneState.settings = Object.assign({}, phoneState.settings, patch);
	applyPhoneSettings(next);
	saveCache();
}

function saveCache() {
	try {
		storage.setItem(PHONE_KEY, JSON.stringify({ v: 1, state: phoneState }));
	}
	catch (error) {
		console.log("slide-stats: cache save failed: " + error);
	}
}

function loadCache() {
	try {
		const raw = storage.getItem(PHONE_KEY);
		if (raw) {
			const cached = JSON.parse(raw);
			if (cached && cached.v === 1 && cached.state && cached.state.today && cached.state.season)
				phoneState = cached.state;
		}
	}
	catch (error) {
		console.log("slide-stats: cache load failed: " + error);
	}
	if (phoneState) {
		applyPhoneSettings(phoneState.settings || {});
		statusNoGps = !(phoneState.status && phoneState.status.gps);
		remember("day", phoneState.today.date, phoneState.today);
		remember("season", phoneState.season.key, phoneState.season);
	}
	else
		applyPhoneSettings(DISPLAY_DEFAULTS);
}

function applyState(raw) {
	let state;
	try {
		state = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad state: " + error);
		return;
	}
	if (!state || !state.today || !state.season)
		return;

	phoneState = state;
	applyPhoneSettings(state.settings || {});
	statusNoGps = !(state.status && state.status.gps);
	remember("day", state.today.date, state.today);
	remember("season", state.season.key, state.season);
	updateTheme();
	saveCache();
	draw();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function showScreen(name) {
	currentScreen = name;
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

/* ------------------------------------------------------------------ */
/* Vibrations                                                          */
/* ------------------------------------------------------------------ */

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

function handlePhoneEvent(raw) {
	let event;
	try {
		event = JSON.parse(raw);
	}
	catch (error) {
		console.log("slide-stats: bad event: " + error);
		return;
	}
	if (!event || (event.type !== "start" && event.type !== "end"))
		return;
	statusNoGps = false;
	vibrate(event.type);
}

/* ------------------------------------------------------------------ */
/* Watch-phone sync                                                    */
/* ------------------------------------------------------------------ */

function setupMessage() {
	try {
		message = new Message({
			keys: MESSAGE_KEYS,
			input: 1024,
			output: 1024,
			onReadable() {
				const msg = this.read();
				const state = msg.get("State");
				if (state)
					applyState(state);
				const event = msg.get("Event");
				if (event)
					handlePhoneEvent(event);
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
				flushCommands();
				requestRefresh(false);
				ensureScreenSummary();
				flushQuery();
			},
			onSuspend() {
				messageReady = false;
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

function writeMessage(payload) {
	if (!message || !messageReady)
		return false;
	try {
		message.write(payload);
		messageReady = false;
		return true;
	}
	catch (error) {
		messageReady = false;
		console.log("slide-stats: message write failed: " + error);
		return false;
	}
}

function sendCommand(command) {
	if (commandQueue.length >= 8)
		return;
	commandQueue.push(command);
	flushCommands();
}

function flushCommands() {
	if (!commandQueue.length)
		return;
	const command = commandQueue[0];
	if (!writeMessage(new Map([["Command", JSON.stringify(command)]])))
		return;
	commandQueue.shift();
	if (commandQueue.length)
		setTimeout(flushCommands, 250);
}

function stateStale() {
	if (!phoneState)
		return true;
	if (!phoneState.today || phoneState.today.date !== Fmt.dayKey(new Date()))
		return true;
	return Date.now() - (phoneState.generatedAt || 0) > 300000;
}

function requestRefresh(force) {
	const at = Date.now();
	if (!force && !stateStale())
		return;
	if (!force && at - lastRefreshAt < 15000)
		return;
	lastRefreshAt = at;
	sendCommand({ type: "refresh" });
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
	if (querying || !queryQueue.length)
		return;
	activeQuery = queryQueue.shift();
	querying = true;
	if (!writeMessage(new Map([["Query", JSON.stringify({
		v: 1, kind: activeQuery.kind, key: activeQuery.key,
	})]]))) {
		querying = false;
		queryQueue.unshift(activeQuery);
		activeQuery = null;
		return;
	}
	queryTimer = setTimeout(() => {
		querying = false;
		if (activeQuery)
			queryQueue.unshift(activeQuery);
		activeQuery = null;
		queryTimer = null;
		flushQuery();
	}, 8000);
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
	delete history.day[data.date];
	if (selectedDayKey === data.date && (!phoneState || data.date !== phoneState.today.date))
		selectedDayKey = todayKey();
	requestRefresh(true);
	draw();
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

function applySettings(raw) {
	try {
		const next = JSON.parse(raw);
		if (!next || typeof next !== "object")
			return;
		if (phoneState)
			phoneState.settings = Object.assign({}, phoneState.settings, next);
		applyPhoneSettings(Object.assign({}, settings, next));
		updateTheme();
		saveCache();
		draw();
	}
	catch (error) {
		console.log("slide-stats: bad settings: " + error);
	}
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function setPaused(paused) {
	if (settings.paused === paused)
		return;
	updateLocalSettings({ paused });
	sendCommand({ type: "pause", value: paused });
	draw();
}

function setClosed(closed) {
	if (settings.closed === closed)
		return;
	updateLocalSettings({ closed });
	sendCommand({ type: "day", value: closed });
	draw();
}

function undoLastLift() {
	sendCommand({ type: "undo" });
}

function setUnits(units) {
	if (settings.units === units)
		return;
	updateLocalSettings({ units });
	sendCommand({ type: "units", value: units });
	draw();
}

function setVibration(vibration) {
	if (settings.vibration === vibration)
		return;
	updateLocalSettings({ vibration });
	sendCommand({ type: "vibration", value: vibration });
	draw();
}

// Keep in sync with the ACTION enum in src/c/ffi.c.
const ACTION = {
	dayClose: 1,
	dayOpen: 2,
	pause: 3,
	resume: 4,
	undo: 5,
	metric: 6,
	imperial: 7,
	vibrationOn: 8,
	vibrationOff: 9,
	sync: 10,
};

function handleAction(action) {
	if (action === ACTION.dayClose)
		setClosed(true);
	else if (action === ACTION.dayOpen)
		setClosed(false);
	else if (action === ACTION.pause)
		setPaused(true);
	else if (action === ACTION.resume)
		setPaused(false);
	else if (action === ACTION.undo)
		undoLastLift();
	else if (action === ACTION.metric)
		setUnits("metric");
	else if (action === ACTION.imperial)
		setUnits("imperial");
	else if (action === ACTION.vibrationOn)
		setVibration(true);
	else if (action === ACTION.vibrationOff)
		setVibration(false);
	else if (action === ACTION.sync)
		requestRefresh(true);
}

function nativeMenu() {
	if (typeof Natives === "undefined" || !Natives.slide_action_menu_open)
		return null;
	return Natives;
}

function pollActionMenu() {
	actionMenuTimer = null;
	try {
		const native = nativeMenu();
		if (!native) {
			actionMenu = false;
			draw();
			return;
		}
		const result = native.slide_action_menu_result();
		if (result === 0) {
			actionMenuTimer = setTimeout(pollActionMenu, 150);
			return;
		}
		actionMenu = false;
		lastMenuCloseAt = Date.now();
		if (result > 0)
			handleAction(result);
		draw();

		// A native window can leave the display's destination bitmap offset until
		// the firmware repaints the app layer. Draw once more after that happens.
		if (menuRedrawTimer)
			clearTimeout(menuRedrawTimer);
		menuRedrawTimer = setTimeout(() => {
			menuRedrawTimer = null;
			draw();
		}, 250);
	}
	catch (error) {
		actionMenu = false;
		console.log("action menu poll failed: " + error);
		draw();
	}
}

function openActionMenu() {
	if (actionMenu)
		return;
	const native = nativeMenu();
	if (!native)
		return;
	if (menuRedrawTimer) {
		clearTimeout(menuRedrawTimer);
		menuRedrawTimer = null;
	}
	const flags = (isDayClosed() ? 1 : 0) |
		(settings.paused ? 2 : 0) |
		(settings.units === "imperial" ? 4 : 0) |
		(settings.vibration ? 0 : 8);
	const accent = settings.theme && typeof settings.theme.accent === "number"
		? settings.theme.accent : 0;
	try {
		if (native.slide_action_menu_open(flags, accent) !== 1)
			return;
		actionMenu = true;
		pollActionMenu();
	}
	catch (error) {
		actionMenu = false;
		console.log("action menu failed: " + error);
	}
}

function exitApp() {
	if (actionMenuTimer) {
		clearTimeout(actionMenuTimer);
		actionMenuTimer = null;
	}
	if (menuRedrawTimer) {
		clearTimeout(menuRedrawTimer);
		menuRedrawTimer = null;
	}
	const native = nativeMenu();
	if (native) {
		try {
			native.slide_action_menu_close();
		}
		catch (error) {}
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
		if (actionMenu)
			return;

		// Open on release so the click that launches the native menu is not
		// also delivered to the new menu as a selection.
		if (type === "select") {
			if (!down && currentScreen === "main")
				openActionMenu();
			return;
		}
		if (!down)
			return;

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
		else if (type === "back") {
			if (currentScreen !== "main")
				showScreen("main");
			else if (Date.now() - lastMenuCloseAt > 1000)
				exitApp();
		}
	},
});

watch.addEventListener("minutechange", () => {
	if (!actionMenu && currentScreen === "main")
		draw();
});

watch.addEventListener("daychange", () => {
	if (currentScreen === "today")
		selectedDayKey = Fmt.dayKey(new Date());
	requestRefresh(true);
	draw();
});

watch.addEventListener("didFocus", inFocus => {
	if (!inFocus)
		return;
	if (actionMenu) {
		if (!actionMenuTimer)
			pollActionMenu();
		return;
	}
	requestRefresh(false);
	ensureScreenSummary();
	draw();
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

loadCache();
updateTheme();
setupMessage();
draw();
