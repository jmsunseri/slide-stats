import test from "node:test";
import assert from "node:assert/strict";
import {
	dayKey,
	dateFromKey,
	seasonKey,
	seasonLabel,
} from "../src/embeddedjs/lib/core.js";

const north = { seasonMode: "north" };
const south = { seasonMode: "south" };

test("day keys round-trip as local dates", () => {
	const date = new Date(2026, 2, 14);
	assert.equal(dayKey(date), "2026-03-14");
	assert.equal(dayKey(dateFromKey("2026-03-14")), "2026-03-14");
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

