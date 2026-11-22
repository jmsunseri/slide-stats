import test from "node:test";
import assert from "node:assert/strict";
import {
	groupThousands,
	formatVertical,
	formatTime,
	formatDateShort,
	formatAverage,
	toFeet,
} from "../src/embeddedjs/lib/core.js";

test("thousands grouping handles negatives and short values", () => {
	assert.equal(groupThousands(0), "0");
	assert.equal(groupThousands(999), "999");
	assert.equal(groupThousands(1000), "1,000");
	assert.equal(groupThousands(1240), "1,240");
	assert.equal(groupThousands(-1234), "-1,234");
	assert.equal(groupThousands(1234567), "1,234,567");
});

test("vertical shows magnitude without a leading plus", () => {
	assert.equal(formatVertical(1240, "metric"), "1,240 m");
	assert.equal(formatVertical(0, "metric"), "0 m");
	assert.equal(formatVertical(500, "imperial"), "1,640 ft");
});

test("metres convert to feet", () => {
	assert.ok(Math.abs(toFeet(1000) - 3280.84) < 0.01);
});

test("clock follows 12 and 24 hour preferences", () => {
	const morning = new Date(2026, 2, 14, 0, 5);
	const afternoon = new Date(2026, 2, 14, 13, 7);
	const noon = new Date(2026, 2, 14, 12, 0);
	assert.equal(formatTime(morning, true), "12:05a");
	assert.equal(formatTime(afternoon, true), "1:07p");
	assert.equal(formatTime(noon, true), "12:00p");
	assert.equal(formatTime(afternoon, false), "13:07");
	assert.equal(formatTime(morning, false), "00:05");
});

test("averages respect units", () => {
	assert.equal(formatAverage(376, "metric"), "376 m");
	assert.equal(formatAverage(376, "imperial"), "1,234 ft");
});

test("short dates", () => {
	assert.equal(formatDateShort("2026-03-14"), "Mar 14");
	assert.equal(formatDateShort("2026-12-01"), "Dec 01");
});
