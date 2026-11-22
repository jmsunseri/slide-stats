// Map the watch app's manifest module names onto files for Node tests.
const modules = {
	detector: new URL("../src/embeddedjs/lib/detector.js", import.meta.url).href,
	"day-store": new URL("../src/embeddedjs/lib/day-store.js", import.meta.url).href,
	season: new URL("../src/embeddedjs/lib/season.js", import.meta.url).href,
	format: new URL("../src/embeddedjs/lib/format.js", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
	if (modules[specifier])
		return { url: modules[specifier], shortCircuit: true };
	return nextResolve(specifier, context);
}
