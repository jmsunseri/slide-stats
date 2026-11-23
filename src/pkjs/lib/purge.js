/*
 * Pure helpers for the Clay data-management controls. `values` is the raw
 * response keyed by `purge:<season>`; `snapshot` maps season keys to the days
 * that were shown on the page.
 */

function deleteDays(lifts, values, snapshot, todayKey) {
	const result = { removed: 0, deletedToday: [] };
	if (!values || !snapshot)
		return result;
	for (const key of Object.keys(values)) {
		if (key.indexOf("purge:") !== 0)
			continue;
		const season = key.slice("purge:".length);
		const days = snapshot[season] || [];
		const flags = values[key];
		if (!Array.isArray(flags))
			continue;
		for (let i = 0; i < days.length && i < flags.length; i++) {
			if (!flags[i])
				continue;
			const date = days[i].date;
			if (!lifts[date])
				continue;
			delete lifts[date];
			result.removed++;
			if (date === todayKey)
				result.deletedToday.push(date);
		}
	}
	return result;
}

module.exports = { deleteDays };
