/**
 * Compatibility barrel for the Node tests. The watch imports `format`
 * directly so the detector and day store stay out of the watch archive.
 */

export * from "./detector.js";
export * from "./day-store.js";
export * from "./format.js";
