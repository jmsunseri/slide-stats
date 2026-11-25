#!/usr/bin/env node
/*
 * Generate the PKJS copy of the pure lift detector.
 *
 * The source of truth is `src/embeddedjs/lib/detector.js` (ES module). The PKJS
 * runtime does not accept `export` syntax, so the phone build uses a generated
 * CommonJS copy of the same source. Run this after changing the detector:
 *
 *   node tools/generate-pkjs-detector.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(ROOT, "src/embeddedjs/lib/detector.js");
const targetPath = path.join(ROOT, "src/pkjs/lib/detector.js");
const checkOnly = process.argv.includes("--check");

const source = fs.readFileSync(sourcePath, "utf8");
const exportIndex = source.lastIndexOf("\nexport {");
if (exportIndex < 0)
	throw new Error("could not locate the detector export block in detector.js");

const detector = source.slice(0, exportIndex).trimEnd();
const output = `/* GENERATED from src/embeddedjs/lib/detector.js; do not edit. */
/* CommonJS copy for the PKJS/phone runtime. */

${detector}

module.exports = { createLiftDetector, DEFAULTS, finite, scaledCoord };
`;

if (checkOnly) {
	const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
	if (current !== output) {
		console.error(`${path.relative(ROOT, targetPath)} is out of date; run npm run generate:phone-detector`);
		process.exit(1);
	}
	console.log(`${path.relative(ROOT, targetPath)} is up to date`);
}
else {
	fs.writeFileSync(targetPath, output);
	console.log(`wrote ${path.relative(ROOT, targetPath)} (${output.length} bytes)`);
}
