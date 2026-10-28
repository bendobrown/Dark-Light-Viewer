# Changelog

## v3.4 (2026)

Reliability, method and plain-language release. Replaces v3.1.

### Method

- **Missing data is not darkness.** Monthly values with no cloud-free observation are removed. In v3.1 they were averaged in as zero, which made cloudy and high-latitude places look darker than they were.
- **Calendar-month matching.** Each later month is paired with the same calendar month in the earlier period, and a spot is compared only on months seen clearly in both. Default: at least 75% of months (9 of 12; short windows round up, so 3 of 3 and 5 of 6).
- **Stray-light corrected data at higher latitudes.** Auto mode uses `VCMSLCFG` for areas centred at 30° latitude or more, when both periods start in 2014 or later and the corrected data covers the dates. Otherwise it uses `VCMCFG` and says why. Either can be chosen by hand.
- **Headline figure.** The change in total light across the same lit spots in both periods, replacing v3.1's mean of per-pixel percentages over the whole rectangle, which was pulled towards zero by dark land and sea.
- **Explicit periods.** Two periods of equal length, shown everywhere with their dates. A custom earlier period ends at the chosen month; in v3.1 it was centred on it, so it included months after the date chosen. Overlapping periods are refused unless allowed.
- **Change areas.** Rises and falls are clustered separately; statistics and size come from each area's own pixels and `ee.Image.pixelArea()`. v3.1 took them from a fixed 2 km circle around each centre and assumed 0.25 km² per pixel. A spot must change by both the percentage threshold and at least 1 nW/cm²/sr, so tiny changes in dark places are not counted.
- **Percentile spread** is calculated on capped values (+1,000%) with fixed-width buckets, so it stays meaningful on large areas.

### Results people can read

- A plain-language summary leads every result, with "This measures light, not its cause".
- Cautions when: under 80% of lit spots could be compared; the total is flat but parts moved in opposite directions; more than a quarter of the lit spots are at sea (with a one-click re-run without them); a very large rise could be fires or gas flares; the periods cover different months; single months are compared; data are missing.
- No headline figure with fewer than 25 compared lit spots, or where there was no light in the earlier period.
- "What does this mean?" guide and a plain colour legend for every view. The legend repeats the cautions.
- Map clicks show plain values and a monthly chart, and say when the spot is outside the analysed area.

### Reliability

- Failed or timed-out requests show as failures, never as "complete" or "0 change areas".
- Results from older requests cannot overwrite newer ones; every result keeps its own settings; changing a setting marks the result as out of date.
- Archive dates are read from both datasets.

### Area, dates and sharing

- Area from the map view, an FAO GAUL 2015 boundary, a drawn shape or pasted GeoJSON.
- Story locations with event dates; areas larger than 1,000,000 km² are refused.
- Links reproduce the exact area, dates, settings, view and detected areas.

### Downloads

- Centre points (GeoJSON, CSV, KML), outlines (GeoJSON) and the analysed area (GeoJSON), with geometry, dates, dataset and all settings in every record. Google Drive export in the Code Editor.

### Testing

- 26 built-in self-tests (set `RUN_TESTS = true` and check the Console).
- Tested on real data across conflict, disaster, cloudy tropical, high-latitude, coastal and open-sea areas, including deliberate edge cases (tiny areas, open ocean, areas crossing 180°, broken links).

## v3.1

First public release.
