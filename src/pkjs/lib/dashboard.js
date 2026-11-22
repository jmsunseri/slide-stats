/*
 * Generates the local configuration/stats page. The page is opened by PKJS as
 * a data: URL, so it needs no network and no server.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

function group(value) {
	const rounded = Math.round(value);
	const negative = rounded < 0;
	const digits = String(Math.abs(rounded));
	let result = "";
	for (let i = 0; i < digits.length; i++) {
		if (i && ((digits.length - i) % 3) === 0)
			result += ",";
		result += digits[i];
	}
	return negative ? "-" + result : result;
}

function esc(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtDist(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? metres * 3.28084 : metres;
	return group(value) + (units === "imperial" ? " ft" : " m");
}

function fmtSigned(metres, units) {
	if (metres === null || metres === undefined || !isFinite(metres))
		return "--";
	const value = units === "imperial" ? metres * 3.28084 : metres;
	const rounded = Math.round(value);
	return (rounded > 0 ? "+" : "") + group(rounded) + (units === "imperial" ? " ft" : " m");
}

function fmtTime(timestamp) {
	if (!timestamp)
		return "--";
	const date = new Date(timestamp);
	return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

function parseKey(key) {
	const parts = key.split("-");
	return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function fmtDate(key) {
	const date = parseKey(key);
	return MONTHS[date.getMonth()] + " " + date.getDate();
}

function fmtDay(key) {
	const date = parseKey(key);
	return WEEKDAYS[date.getDay()] + ", " + MONTHS[date.getMonth()] + " " + date.getDate();
}

function empty(message) {
	return '<p class="empty">' + esc(message) + '</p>';
}

function liftRows(lifts, units) {
	if (!lifts.length)
		return empty("No lifts recorded.");
	let rows = "";
	lifts.forEach((lift, index) => {
		rows += "<tr><td>" + (index + 1) + "</td>" +
			"<td>" + fmtTime(lift.startTime) + "</td>" +
			"<td>" + fmtTime(lift.endTime) + "</td>" +
			"<td class=\"num\">" + fmtSigned(lift.gain, units) + "</td></tr>";
	});
	return '<table><thead><tr><th>#</th><th>Board</th><th>Top</th><th class="num">Gain</th></tr></thead><tbody>' +
		rows + "</tbody></table>";
}

function todaySection(summary, units) {
	const today = summary.today;
	if (!today.r) {
		return '<section class="panel active" data-panel="today">' +
			'<div class="hero"><div class="hero-label">TODAY · ' + fmtDate(today.date) + '</div>' +
			'<div class="hero-value">0 m</div><div class="hero-sub">No lifts yet</div></div>' +
			empty("Once the watch sees a lift, it will appear here.") + "</section>";
	}
	return '<section class="panel active" data-panel="today">' +
		'<div class="hero"><div class="hero-label">TODAY · ' + fmtDate(today.date) + '</div>' +
		'<div class="hero-value">' + fmtSigned(today.v, units) + '</div>' +
		'<div class="hero-sub">' + today.r + (today.r === 1 ? " run" : " runs") + '</div></div>' +
		'<div class="grid">' +
		'<div class="stat"><span>First lift</span><b>' + fmtTime(today.first) + '</b></div>' +
		'<div class="stat"><span>Last lift</span><b>' + fmtTime(today.last) + '</b></div>' +
		'<div class="stat"><span>Average</span><b>' + fmtDist(today.average, units) + '</b></div>' +
		'<div class="stat"><span>Longest</span><b>' + fmtSigned(today.longest, units) + '</b></div>' +
		"</div><h2>Lifts</h2>" + liftRows(today.lifts, units) + "</section>";
}

function tripsSection(summary, units) {
	const trips = summary.season.trips;
	if (!trips.length)
		return '<section class="panel" data-panel="trips">' + empty("No trips yet this season.") + "</section>";
	let html = '<section class="panel" data-panel="trips">';
	trips.slice().reverse().forEach((trip, index) => {
		html += '<div class="card"><div class="card-head"><h2>' + esc(trip.label) + "</h2>" +
			'<span class="pill">' + trip.daysCount + (trip.daysCount === 1 ? " day" : " days") + "</span></div>" +
			'<div class="grid">' +
			'<div class="stat"><span>Vertical</span><b>' + fmtSigned(trip.vertical, units) + '</b></div>' +
			'<div class="stat"><span>Runs</span><b>' + trip.runs + '</b></div>' +
			'<div class="stat"><span>Average / day</span><b>' + fmtDist(trip.averageVertical, units) + '</b></div>' +
			'<div class="stat"><span>Best day</span><b>' + (trip.bestDay ? fmtDate(trip.bestDay.date) : "--") + '</b></div>' +
			"</div></div>";
	});
	return html + "</section>";
}

function chart(series, units) {
	if (series.length < 2)
		return "";
	const max = Math.max.apply(null, series.map(day => day.vertical)) || 1;
	const width = Math.max(320, series.length * 10);
	const height = 110;
	const barWidth = width / series.length;
	let bars = "";
	series.forEach((day, index) => {
		const barHeight = Math.max(2, Math.round((day.vertical / max) * (height - 20)));
		bars += '<rect x="' + (index * barWidth + 1).toFixed(1) + '" y="' + (height - barHeight) +
			'" width="' + Math.max(1, barWidth - 2).toFixed(1) + '" height="' + barHeight + '" rx="1"></rect>';
	});
	return '<div class="chart"><svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">' +
		bars + "</svg></div>" +
		'<div class="chart-labels"><span>' + fmtDate(series[0].date) + "</span><span>" +
		fmtSigned(max, units) + "</span><span>" + fmtDate(series[series.length - 1].date) + "</span></div>";
}

function seasonSection(summary, units) {
	const season = summary.season;
	const all = summary.allTime;
	return '<section class="panel" data-panel="season">' +
		'<div class="hero"><div class="hero-label">' + esc(season.label) + ' SEASON</div>' +
		'<div class="hero-value">' + fmtSigned(season.vertical, units) + '</div>' +
		'<div class="hero-sub">' + season.daysCount + (season.daysCount === 1 ? " ski day" : " ski days") + '</div></div>' +
		'<div class="grid">' +
		'<div class="stat"><span>Runs</span><b>' + season.runs + '</b></div>' +
		'<div class="stat"><span>Average / day</span><b>' + fmtDist(season.averageVertical, units) + '</b></div>' +
		'<div class="stat"><span>Best day</span><b>' + (season.bestDay ? fmtDate(season.bestDay.date) : "--") + '</b></div>' +
		'<div class="stat"><span>Trips</span><b>' + season.trips.length + '</b></div>' +
		"</div>" + chart(season.series, units) +
		'<h2>All time</h2><div class="grid">' +
		'<div class="stat"><span>Vertical</span><b>' + fmtSigned(all.vertical, units) + '</b></div>' +
		'<div class="stat"><span>Ski days</span><b>' + all.daysCount + '</b></div>' +
		'<div class="stat"><span>Runs</span><b>' + all.runs + '</b></div>' +
		'<div class="stat"><span>Best day</span><b>' + (all.bestDay ? fmtDate(all.bestDay.date) : "--") + '</b></div>' +
		"</div></section>";
}

function option(value, current) {
	return '<option value="' + value + '"' + (value === current ? " selected" : "") + ">" +
		value.charAt(0).toUpperCase() + value.slice(1) + "</option>";
}

function monthOptions(current) {
	let html = "";
	for (let i = 1; i <= 12; i++)
		html += '<option value="' + i + '"' + (i === current ? " selected" : "") + ">" + MONTHS[i - 1] + "</option>";
	return html;
}

function dayOptions(current) {
	let html = "";
	for (let i = 1; i <= 31; i++)
		html += '<option value="' + i + '"' + (i === current ? " selected" : "") + ">" + i + "</option>";
	return html;
}

function settingsSection(settings, summary) {
	const s = settings;
	const d = s.detection;
	const json = JSON.stringify(settings).replace(/</g, "\\u003c");
	return '<section class="panel" data-panel="settings">' +
		'<h2>Units</h2><div class="field"><label for="units">Distance</label>' +
		'<select id="units"><option value="metric"' + (s.units !== "imperial" ? " selected" : "") + '>Metric (m)</option>' +
		'<option value="imperial"' + (s.units === "imperial" ? " selected" : "") + '>Imperial (ft)</option></select></div>' +
		'<h2>Behaviour</h2>' +
		'<div class="field switch"><label for="vibration">Vibrate on lift start and end</label>' +
		'<input type="checkbox" id="vibration"' + (s.vibration ? " checked" : "") + '></div>' +
		'<div class="field switch"><label for="trips">Show trips</label>' +
		'<input type="checkbox" id="trips"' + (s.trips !== false ? " checked" : "") + '></div>' +
		'<h2>Season</h2><div class="field"><label for="seasonMode">Hemisphere</label>' +
		'<select id="seasonMode">' +
		'<option value="north"' + (s.seasonMode === "north" ? " selected" : "") + '>Northern (Sep–Aug)</option>' +
		'<option value="south"' + (s.seasonMode === "south" ? " selected" : "") + '>Southern (Mar–Feb)</option>' +
		'<option value="custom"' + (s.seasonMode === "custom" ? " selected" : "") + '>Custom start</option>' +
		'<option value="none"' + (s.seasonMode === "none" ? " selected" : "") + '>No seasons (all time)</option>' +
		"</select></div>" +
		'<div class="field-row"><div class="field"><label for="seasonStartMonth">Custom start month</label>' +
		'<select id="seasonStartMonth">' + monthOptions(s.seasonStartMonth || 9) + "</select></div>" +
		'<div class="field"><label for="seasonStartDay">Day</label>' +
		'<select id="seasonStartDay">' + dayOptions(s.seasonStartDay || 1) + "</select></div></div>" +
		'<h2>Lift detection</h2>' +
		'<div class="field-row"><div class="field"><label for="minLiftGainM">Minimum lift gain (m)</label>' +
		'<input type="number" id="minLiftGainM" min="5" max="50" step="1" value="' + (d.minLiftGainM || 10) + '"></div>' +
		'<div class="field"><label for="endDescentM">Descent that ends a lift (m)</label>' +
		'<input type="number" id="endDescentM" min="3" max="20" step="1" value="' + (d.endDescentM || 5) + '"></div></div>' +
		'<div class="field-row"><div class="field"><label for="fastWindowMs">Fast window (seconds)</label>' +
		'<input type="number" id="fastWindowMs" min="20" max="60" step="5" value="' + Math.round((d.fastWindowMs || 30000) / 1000) + '"></div>' +
		'<div class="field"><label for="slowWindowMs">Slow window (seconds)</label>' +
		'<input type="number" id="slowWindowMs" min="60" max="180" step="10" value="' + Math.round((d.slowWindowMs || 90000) / 1000) + '"></div></div>' +
		'<div class="field"><label for="maxSpeedMps">Maximum speed (m/s)</label>' +
		'<input type="number" id="maxSpeedMps" min="0" max="15" step="1" value="' + (d.maxSpeedMps || 8) + '"></div>' +
		'<p class="hint">The minimum gain is also the detection threshold. Changing these affects future lifts, not past ones.</p>' +
		'<button id="save">Save settings</button>' +
		'<p class="hint">Stats are stored on this phone. Open Slide Stats on the watch before syncing.</p>' +
		'<script type="application/json" id="settings-data">' + json + "</script>" +
		"</section>";
}

function renderBundle(options) {
	const summary = options.summary;
	const settings = options.settings;
	const units = settings.units === "imperial" ? "imperial" : "metric";
	const generated = new Date(summary.generatedAt);
	const generatedText = MONTHS[generated.getMonth()] + " " + generated.getDate() + ", " +
		pad2(generated.getHours()) + ":" + pad2(generated.getMinutes());
	const showTrips = settings.trips !== false;

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Slide Stats</title>
<style>
:root{--ink:#101828;--muted:#667085;--line:#e4e7ec;--bg:#f5f6f8;--card:#fff;--accent:#2f6fed;--accent-soft:#eaf1ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:var(--ink);color:#fff;padding:20px 18px 26px}
header h1{margin:0;font-size:24px;letter-spacing:-.02em}
header p{margin:4px 0 0;color:#c7cdd8;font-size:13px}
main{max-width:720px;margin:0 auto;padding:0 14px 40px}
nav{display:flex;gap:6px;margin:-16px 0 16px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;position:sticky;top:8px;z-index:5;box-shadow:0 2px 10px rgba(16,24,40,.06)}
nav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:14px;padding:9px 4px;border-radius:9px;cursor:pointer}
nav button.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.panel{display:none}
.panel.active{display:block}
.hero{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:14px}
.hero-label{color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.hero-value{font-size:40px;font-weight:700;letter-spacing:-.03em;margin:6px 0 0}
.hero-sub{color:var(--muted);font-size:15px;margin-top:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.stat span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.stat b{display:block;font-size:19px;margin-top:3px}
h2{font-size:16px;margin:22px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.card-head h2{margin:0}
.pill{background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:14px;padding:18px;text-align:center}
.chart{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 10px 6px;margin-bottom:4px}
.chart svg{display:block;width:100%;height:110px}
.chart rect{fill:var(--accent)}
.chart-labels{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;padding:0 4px;margin-bottom:14px}
.field{margin-bottom:12px}
.field label{display:block;color:var(--muted);font-size:13px;margin-bottom:5px}
select,input[type=number]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;color:var(--ink)}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.switch label{margin:0}
.switch input{width:20px;height:20px;accent-color:var(--accent)}
button#save{width:100%;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:600;padding:14px;margin-top:10px;cursor:pointer}
.hint{color:var(--muted);font-size:12px;margin:8px 0 0}
footer{text-align:center;color:var(--muted);font-size:12px;padding:22px 10px}
@media (min-width:560px){.grid{grid-template-columns:repeat(4,1fr)}}
</style></head>
<body>
<header><h1>Slide Stats</h1><p>${esc(summary.season.label)} season · updated ${esc(generatedText)}</p></header>
<main>
<nav><button class="on" data-tab="today">Today</button>${showTrips ? '<button data-tab="trips">Trips</button>' : ""}<button data-tab="season">Season</button><button data-tab="settings">Settings</button></nav>
${todaySection(summary, units)}
${showTrips ? tripsSection(summary, units) : ""}
${seasonSection(summary, units)}
${settingsSection(settings, summary)}
<footer>Data stays on your watch and this phone.</footer>
</main>
<script>
(function(){
  var tabs = document.querySelectorAll("nav button");
  var panels = document.querySelectorAll(".panel");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener("click", function(){
      var name = this.getAttribute("data-tab");
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle("on", tabs[j] === this);
      for (var k = 0; k < panels.length; k++) panels[k].classList.toggle("active", panels[k].getAttribute("data-panel") === name);
    });
  }
  document.getElementById("save").addEventListener("click", function(){
    var s = JSON.parse(document.getElementById("settings-data").textContent);
    s.units = document.getElementById("units").value;
    s.vibration = document.getElementById("vibration").checked;
    s.trips = document.getElementById("trips").checked;
    s.seasonMode = document.getElementById("seasonMode").value;
    s.seasonStartMonth = Number(document.getElementById("seasonStartMonth").value);
    s.seasonStartDay = Number(document.getElementById("seasonStartDay").value);
    s.detection = s.detection || {};
    s.detection.minLiftGainM = Number(document.getElementById("minLiftGainM").value);
    s.detection.endDescentM = Number(document.getElementById("endDescentM").value);
    s.detection.fastWindowMs = Number(document.getElementById("fastWindowMs").value) * 1000;
    s.detection.slowWindowMs = Number(document.getElementById("slowWindowMs").value) * 1000;
    s.detection.maxSpeedMps = Number(document.getElementById("maxSpeedMps").value);
    location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify(s));
  });
})();
</script>
</body></html>`;
}

module.exports = { render: renderBundle };
