/*
 * Phone-side detector pipeline: geolocation samples -> shared detector ->
 * durable phone store -> compact watch state.
 */

const { createLiftDetector } = require("./detector");

function createPhoneDetector(options = {}) {
	const detector = options.detector || createLiftDetector();
	const store = options.store;
	const getSettings = options.getSettings || (() => ({}));
	const onEvent = options.onEvent;

	function addSample(sample) {
		const events = detector.addSample(sample);
		for (const event of events) {
			if (event.type === "end" && store) {
				event.record = store.addLift(event.lift);
				event.state = store.state(getSettings(), new Date(event.lift.endTime));
			}
			if (onEvent)
				onEvent(event);
		}
		return events;
	}

	return {
		addSample,
		snapshot: () => detector.snapshot(),
		restore: state => detector.restore(state),
		reset: () => detector.reset(),
		setOptions: next => detector.setOptions(next),
	};
}

module.exports = { createPhoneDetector };
