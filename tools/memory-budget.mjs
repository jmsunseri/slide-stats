#!/usr/bin/env node
/*
 * Build-time memory budget check for Slide Stats.
 *
 * The watch app starts a Moddable XS machine on top of the Pebble app heap.
 * At startup the following allocations coexist:
 *
 *   XS stack + slot + chunk pools
 *   resident XS archive
 *   fxMapArchive scratch buffer
 *   fxMapArchive identifier table
 *   fxMapArchive maps table
 *
 * The emulator maps the archive in place, so it can boot even when the
 * hardware budget is negative. This script models the hardware case and
 * reports the emulator case separately for comparison.
 *
 * Run after `pebble build`:
 *
 *   node tools/memory-budget.mjs
 *   node tools/memory-budget.mjs --check
 *   node tools/memory-budget.mjs --platform emery --json
 *
 * Exit codes:
 *   0  hardware margin >= REQUIRED_MARGIN (2,048 B)
 *   1  hardware margin < REQUIRED_MARGIN, missing build artifacts, or parse failure
 *
 * APP_HEAP_BASE is calibrated on SDK 4.44 / emery and gabbro:
 *   measured heap_bytes_free() before moddable_createMachine = 122,144
 *   logging-build virtual_size                               =     712
 *   APP_HEAP_BASE                                           = 122,856
 * The clean app's free heap is APP_HEAP_BASE - virtual_size.
 * Re-calibrate if the SDK, runtime, or memory layout changes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APP_HEAP_BASE = {
	emery: 122856,
	gabbro: 122856,
};
const MAPPER_SCRATCH = 1024 + 256;
const TXID_BYTES = 2;
// Hard floor: the startup model must leave at least this much free heap.
const REQUIRED_MARGIN = 2048;
// Comfort target: enough room for future startup-sensitive changes.
const TARGET_MARGIN = 4096;

function fail(message) {
	console.error(`memory-budget: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {
		platforms: ["emery", "gabbro"],
		check: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check")
			options.check = true;
		else if (arg === "--json")
			options.json = true;
		else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: node tools/memory-budget.mjs [options]

Options:
  --platform <emery|gabbro|all>  Platform(s) to inspect (default: all)
  --check                        Exit non-zero when the hardware margin is below 2,048 B
  --json                         Print machine-readable results
  --help                         Show this help

Run after pebble build. The emulator maps the archive in place, so a
successful emulator boot does not prove the hardware margin.`);
			process.exit(0);
		}
		else if (arg === "--platform" || arg.startsWith("--platform=")) {
			const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++i];
			if (!value)
				fail("--platform needs a value");
			if (value === "all")
				options.platforms = ["emery", "gabbro"];
			else if (value === "emery" || value === "gabbro")
				options.platforms = [value];
			else
				fail(`unknown platform: ${value}`);
		}
		else
			fail(`unknown argument: ${arg}`);
	}
	return options;
}

function readPools() {
	const source = fs.readFileSync(path.join(ROOT, "src/c/mdbl.c"), "utf8");
	const read = name => {
		const match = source.match(new RegExp(`\\.${name}\\s*=\\s*(\\d+)`));
		if (!match)
			fail(`could not find .${name} in src/c/mdbl.c`);
		return Number(match[1]);
	};
	const stack = read("stack");
	const slot = read("slot");
	const chunk = read("chunk");
	return { stack, slot, chunk, total: stack + slot + chunk };
}

function readVirtualSize(binPath) {
	if (!fs.existsSync(binPath))
		fail(`missing ${path.relative(ROOT, binPath)}; run pebble build first`);
	const bin = fs.readFileSync(binPath);
	if (bin.length < 0x84)
		fail(`${path.relative(ROOT, binPath)} is too small to contain a process header`);
	const low = bin.readUInt16LE(0x80);
	const high = bin[0x83] || 0;
	const size = low | (high << 16);
	return size || bin.length;
}

function readArchive(platform) {
	const direct = path.join(ROOT, "build", "mods", platform, "mc.xsa");
	const wrapped = path.join(ROOT, "build", platform, "mods", platform, "mc.xsa.MOD.reso");
	const archivePath = fs.existsSync(direct) ? direct : wrapped;
	if (!fs.existsSync(archivePath))
		fail(`missing archive for ${platform}; run pebble build first`);

	const buffer = fs.readFileSync(archivePath);
	const signature = buffer.indexOf(Buffer.from("XS_A"));
	if (signature < 4)
		fail(`no XS_A archive signature in ${path.relative(ROOT, archivePath)}`);

	const start = signature - 4;
	const archiveSize = buffer.readUInt32BE(start);
	const atoms = {};
	let symbOffset = -1;
	let offset = start + 8;
	while (offset + 8 <= buffer.length) {
		const size = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		if (!size)
			break;
		atoms[type] = size;
		if (type === "SYMB")
			symbOffset = offset;
		if (type === "RSRC")
			break;
		offset += size;
	}

	const symbols = symbOffset >= 0 ? buffer.readUInt16LE(symbOffset + 8) : 0;
	const maps = Math.max(0, (atoms.MAPS || 0) - 8);
	return {
		archivePath,
		archiveSize,
		atoms,
		symbols,
		maps,
	};
}

function inspect(platform) {
	const pools = readPools();
	const binPath = path.join(ROOT, "build", platform, "pebble-app.bin");
	const virtualSize = readVirtualSize(binPath);
	const archive = readArchive(platform);
	const freeHeap = APP_HEAP_BASE[platform] - virtualSize;
	const mapperIds = archive.symbols * TXID_BYTES;

	const hardwarePeak = pools.total + archive.archiveSize + MAPPER_SCRATCH +
		mapperIds + archive.maps;
	const emulatorPeak = pools.total + MAPPER_SCRATCH + mapperIds + archive.maps;

	return {
		platform,
		pools,
		virtualSize,
		freeHeap,
		archive,
		mapperScratch: MAPPER_SCRATCH,
		mapperIds,
		mapperMaps: archive.maps,
		hardwarePeak,
		hardwareMargin: freeHeap - hardwarePeak,
		emulatorPeak,
		emulatorMargin: freeHeap - emulatorPeak,
	};
}

function bytes(value) {
	return `${value.toLocaleString("en-US")} B`;
}

function printResult(result) {
	const marginLabel = result.hardwareMargin < REQUIRED_MARGIN
		? "FAIL"
		: (result.hardwareMargin < TARGET_MARGIN ? "WARN" : "OK");
	console.log(`\n${result.platform}`);
	console.log(`  app virtual size      ${bytes(result.virtualSize)}`);
	console.log(`  free heap             ${bytes(result.freeHeap)}`);
	console.log(`  XS pools              ${bytes(result.pools.total)}`);
	console.log(`    stack               ${bytes(result.pools.stack)}`);
	console.log(`    slot                ${bytes(result.pools.slot)}`);
	console.log(`    chunk               ${bytes(result.pools.chunk)}`);
	console.log(`  archive               ${bytes(result.archive.archiveSize)}`);
	console.log(`  mapper scratch        ${bytes(result.mapperScratch)}`);
	console.log(`  mapper identifiers    ${bytes(result.mapperIds)} (${result.archive.symbols} symbols)`);
	console.log(`  mapper maps           ${bytes(result.mapperMaps)}`);
	console.log(`  hardware startup peak ${bytes(result.hardwarePeak)}`);
	console.log(`  hardware margin       ${bytes(result.hardwareMargin)}  ${marginLabel}`);
	console.log(`  emulator margin       ${bytes(result.emulatorMargin)}  (archive mapped in place; informational)`);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const results = options.platforms.map(inspect);

	if (options.json)
		console.log(JSON.stringify({
			results,
			requiredMargin: REQUIRED_MARGIN,
			targetMargin: TARGET_MARGIN,
		}, null, 2));
	else {
		console.log("Slide Stats memory budget");
		console.log("Hardware model: archive is resident in the app heap.");
		for (const result of results)
			printResult(result);
		console.log("\nThe emulator maps the archive in place. A successful emulator boot");
		console.log("does not prove the hardware margin; use the hardware margin above.");
	}

	const failures = results.filter(result => result.hardwareMargin < REQUIRED_MARGIN);
	const warnings = results.filter(result =>
		result.hardwareMargin >= REQUIRED_MARGIN && result.hardwareMargin < TARGET_MARGIN);

	if (options.check) {
		for (const result of failures)
			console.error(`memory-budget: ${result.platform} hardware margin is below ${bytes(REQUIRED_MARGIN)} (${bytes(result.hardwareMargin)})`);
		for (const result of warnings)
			console.error(`memory-budget: ${result.platform} hardware margin is below the ${bytes(TARGET_MARGIN)} target (${bytes(result.hardwareMargin)})`);
		if (failures.length)
			process.exit(1);
	}
}

main();
