import test from "node:test";
import assert from "node:assert/strict";
import {
	dayKey,
	dateFromKey,
	dayNumber,
	seasonKey,
	seasonLabel,
	groupTrips,
	summarize,
} from "../src/embeddedjs/lib/core.js";

const north = { seasonMode: "north" };
const south = { seasonMode: "south" };

test("day keys round-trip as local dates", () => {
	const date = new Date(2026, 2, 14);
	assert.equal(dayKey(date), "2026-03-14");
	assert.equal(dayKey(dateFromKey("2026-03-14")), "2026-03-14");
});

test("dayNumber is a calendar-day difference across DST", () => {
	assert.equal(dayNumber("2026-03-08") - dayNumber("2026-03-07"), 1);
	assert.equal(dayNumber("2026-01-01") - dayNumber("2025-12-31"), 1);
});

test("northern season starts on 1 September", () => {
	assert.equal(seasonKey("2025-08-31", north), "2024");
	assert.equal(seasonKey("2025-09-01", north), "2025");
	assert.equal(seasonKey("2026-03-14", north), "2025");
	assert.equal(seasonKey("2026-08-31", north), "2025");
	assert.equal(seasonLabel("2025", north), "2025-26");
});

test("southern season starts on 1 March", () => {
	assert.equal(seasonKey("2026-02-28", south), "2025");
	assert.equal(seasonKey("2026-03-01", south), "2026");
	assert.equal(seasonKey("2026-08-01", south), "2026");
});

test("Friday and Monday are one trip; Friday and Tuesday are not", () => {
	const days = {
		"2026-01-02": { v: 1000, r: 3 },
		"2026-01-05": { v: 1200, r: 4 },
		"2026-01-06": { v: 1100, r: 4 },
	};
	assert.equal(groupTrips(Object.keys(days), days).length, 1);

	const days2 = {
		"2026-01-02": { v: 1000, r: 3 },
		"2026-01-06": { v: 1200, r: 4 },
	};
	assert.equal(groupTrips(Object.keys(days2), days2).length, 2);
});

test("two rest days link, three rest days break", () => {
	const linked = {
		"2026-01-02": { v: 1000, r: 3 },
		"2026-01-05": { v: 1200, r: 4 },
	};
	assert.equal(groupTrips(Object.keys(linked), linked).length, 1);

	const broken = {
		"2026-01-02": { v: 1000, r: 3 },
		"2026-01-06": { v: 1200, r: 4 },
	};
	assert.equal(groupTrips(Object.keys(broken), broken).length, 2);
});

test("trip totals and averages", () => {
	const days = {
		"2026-01-02": { v: 1000, r: 3 },
		"2026-01-03": { v: 1400, r: 4 },
		"2026-01-05": { v: 1200, r: 5 },
	};
	const trips = groupTrips(Object.keys(days), days);
	assert.equal(trips.length, 1);
	assert.equal(trips[0].daysCount, 3);
	assert.equal(trips[0].vertical, 3600);
	assert.equal(trips[0].runs, 12);
	assert.equal(trips[0].averageVertical, 1200);
	assert.equal(trips[0].bestDay.date, "2026-01-03");
});

test("season summary filters days and computes best day", () => {
	const days = {
		"2025-08-01": { v: 900, r: 2 },		// previous northern season
		"2025-12-01": { v: 800, r: 3 },
		"2026-03-10": { v: 1300, r: 4 },
		"2026-03-14": { v: 1100, r: 3 },
	};
	const summary = summarize(days, north, new Date(2026, 2, 14));
	assert.equal(summary.label, "2025-26");
	assert.equal(summary.days, 3);
	assert.equal(summary.vertical, 3200);
	assert.equal(summary.runs, 10);
	assert.equal(summary.averageVertical, 1067);
	assert.equal(summary.bestDay.date, "2026-03-10");
	assert.equal(summary.trips.length, 3);
});

