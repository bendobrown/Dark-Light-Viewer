# 🔦 Dark Light Viewer

**Detect and visualise changes in nighttime lights globally.**

A free, open-source change detection tool built on Google Earth Engine, using NASA's VIIRS satellite sensor. No coding required. Compare nighttime light levels across any location on Earth, across any period from one month to ten years.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Google%20Earth%20Engine-4285F4)
![Data](https://img.shields.io/badge/data-VIIRS%202012--present-green)
![Status](https://img.shields.io/badge/status-active-brightgreen)

🔗 **[Launch the tool](https://gee-night-lights-474517.projects.earthengine.app/view/darklight-viewer)**  
📝 **[Full methodology and case studies](https://benjaminstrick.com/when-the-lights-go-out-satellites-are-watching/)**


<img width="2035" height="1169" alt="Screenshot 2026-03-03 at 09 16 38" src="https://github.com/user-attachments/assets/5a243d23-7cb5-412f-a62f-d0524072bbaf" />

---

## What's new in v3.4

v3.4 is a reliability and plain-language release. The full list is in [CHANGELOG.md](CHANGELOG.md).

- **Missing data is no longer read as darkness.** Months the satellite could not see clearly are left out, and each spot is compared only on calendar months seen clearly in both periods (September with September), so seasons can't fake a change.
- **A truer headline figure.** The change is now in total light across the same lit spots in both periods, not an average of pixel percentages. The old average was pulled towards zero by dark desert and sea pixels and could understate a large fall several times over.
- **Works far from the equator.** Areas centred at 30° latitude or more switch automatically to the stray-light corrected version of the same NOAA/EOG data, which keeps the summer months. Before, those missing summer months were counted as darkness.
- **A plain-language summary.** Every result opens with what it means in everyday words, plus cautions when coverage is thin, when part of the area brightened and part dimmed, when lights are mostly at sea, or when a big rise could be fires or gas flares. A "What does this mean?" guide explains every colour.
- **Honest failures.** Errors, timeouts and missing data now say so instead of showing "complete" or "0 change areas". Areas with too few lit spots give no headline figure at all.
- **Accurate change areas.** Stats and areas come from each area's own pixels and their true size on the ground. Rises and falls are kept separate.
- **Choose your area and dates.** Map view, country or province boundaries, a drawn shape or pasted GeoJSON. Dates are shown everywhere, and a custom earlier period ends at the month you choose.
- **Downloads and links.** Change areas download as GeoJSON (points and outlines), CSV and KML, with dates and settings written into every record. A link reproduces the exact analysis.
- **Tested.** 26 built-in self-tests, plus testing on real data across conflict, disaster, cloudy tropical, high-latitude, coastal and open-sea areas.

---

## Quickstart

1. Open the [tool](https://gee-night-lights-474517.projects.earthengine.app/view/darklight-viewer)
2. Select a preset location or navigate the map to your area of interest
3. Choose a comparison period (1 year ago is recommended for most use cases)
4. Click **ANALYSE** and read the plain-language summary under it. **What does this mean?** explains the colours
5. Click anywhere on the result map to generate a time-series chart for that location

---

## What it does

The tool compares the most recent VIIRS nighttime light capture against an earlier baseline you choose. It calculates the percentage and absolute change in radiance, pixel by pixel, and presents the result as a colour-coded change detection layer over a split-screen map.

Rather than comparing two images visually, you see exactly which areas lost 30% of their light, which lost 80%, and which have grown — updated automatically as new satellite data arrives.

Click anywhere on the map and the tool generates a monthly time-series chart for that location, drawn from the full VIIRS archive back to 2012. This distinguishes a gradual economic decline from a sudden collapse, and a seasonal fluctuation from a genuine crisis.

---

## Who it's for

| Field | Use case |
|---|---|
| Journalism & OSINT | Verify claims about infrastructure, displacement, or economic activity in restricted-access areas |
| Humanitarian monitoring | Detect mass displacement or infrastructure collapse before ground-level reports arrive |
| Economic research | Track post-disaster recovery, cross-check GDP figures in data-scarce countries |
| Urban planning | Identify genuine population growth vs empty development |
| Disaster response | Map power loss footprint after earthquakes or hurricanes; track recovery over time |
| Environmental monitoring | Flag illegal development, unplanned mining, or fishing activity in restricted zones |
| Academic research | Access real-world global data without coding for geography, economics, and IR students |

---

## Data

- **Sensor:** VIIRS Day/Night Band (DNB), monthly composites
- **Resolution:** ~500 metres per pixel
- **Coverage:** Global, April 2012 to present
- **Source:** NOAA / Earth Observation Group — hosted on Google Earth Engine
- **GEE dataset IDs:** `NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG` (standard, from April 2012) and `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG` (stray-light corrected, from January 2014; used automatically at 30° latitude or more)

---

## How the analysis works

1. The tool reads the latest available VIIRS monthly composite and builds two periods of equal length: an earlier period and a later one. Story locations end the earlier period the month before the event
2. Months with no cloud-free observation (`cf_cvg` = 0) are removed, so missing data never counts as darkness
3. Each later month is paired with the same calendar month in the earlier period. A spot is compared only on months seen clearly in both, and needs at least 75% of them by default (9 of 12; short windows round up, so 3 of 3)
4. The headline is the change in total light across the same lit spots in both periods. A spot is lit if it is above 1 nW/cm²/sr in either period. No headline is given with fewer than 25 compared spots
5. Per-spot percentage change uses the earlier value floored at 0.5 nW/cm²/sr, to avoid dividing by near-zero values in very dark places
6. Change areas group neighbouring spots that changed by at least 30% and 1 nW/cm²/sr (minimum 5 spots). Rises and falls are kept apart, and each area's statistics and size come from its own pixels on the native grid

**Time period options:**

| Selection | Each period | Earlier period ends |
|---|---|---|
| Last 12 months vs the 12 before (default) | 12 months | 12 months before the later period |
| Latest month vs the month before | 1 month | 1 month before |
| Last 3 months vs same 3 months a year earlier | 3 months | 12 months before |
| Last 3 months vs the 3 before | 3 months | 3 months before |
| Last 12 months vs 12 months, 5 years earlier | 12 months | 60 months before |
| Last 12 months vs 12 months, 10 years earlier | 12 months | 120 months before |
| Choose my own dates | 1, 3, 6 or 12 months | The month you choose (overlapping periods refused unless allowed) |

---

## Interpreting results

**Decreases (warm/brown colours)**

| Range | Likely significance |
|---|---|
| >70% | Major event — conflict, disaster, infrastructure collapse |
| 50–70% | Significant — economic decline, mass displacement |
| 30–50% | Moderate — industrial closure, depopulation |

**Increases (cool/teal colours)**

| Range | Likely significance |
|---|---|
| >50% | Rapid urbanisation, major construction |
| 30–50% | Steady growth, economic expansion |

---

## Known limitations

Understanding these limitations is essential for responsible use of the tool.

**Cloud cover.** VIIRS cannot see through clouds. Monthly composites in consistently cloudy regions (much of the tropics, northern Europe in winter) may contain significant data gaps. Comparing two periods with different seasonal cloud cover can produce misleading results.

**LED spectral blind spot.** VIIRS captures light most efficiently in the wavelengths emitted by high-pressure sodium lamps. LED lighting emits more energy in shorter wavelengths that the sensor partially misses. Areas that have transitioned to LED infrastructure may appear to have lost light even when overall illumination is unchanged or has increased. The sensor undercounts LED-lit areas by roughly a third compared to equivalent sodium-lamp installations.

**Fires and gas flares.** Both register as bright light sources and can be mistaken for urban or industrial activity. Regions with active agricultural burning, offshore oil platforms, or volcanic activity will show light signatures unrelated to human settlement.

**Polar regions.** During summer months, the sun does not fully set at high latitudes, preventing the sensor from detecting artificial light. Use with caution above 65° latitude during the April–August period.

**Resolution.** At ~500 metres per pixel, the tool cannot resolve individual buildings or small facilities. It is best suited to neighbourhood, district, or city-level analysis.

**Correlation, not causation.** A drop in nighttime light can reflect grid damage, military light discipline, fuel scarcity, seasonal shutdown, economic policy, or LED transition. The tool tells you that something has changed. Determining why requires additional reporting, ground truth, and contextual analysis. **Always cross-reference findings with other data sources before drawing conclusions.**

---

## Case studies

| Location | Period | Key finding |
|---|---|---|
| Gaza Strip | Oct 2023–2024 | ~91% light loss in Gaza City |
| Ukraine | Feb 2022–present | ~86% drop in Sumy within days of invasion |
| Luttelgeest, Netherlands | 2014–2023 | 37% decline — LED transition, not crisis |
| Thai–Myanmar border | 2021–present | Light increases corroborate displacement reporting |
| Egypt New Administrative Capital | 2015–present | City built and lit before population arrived |

The following cases illustrate both the analytical value and the interpretive limits of nighttime light analysis.

**Gaza Strip (2023–2024):** Following the outbreak of conflict in October 2023, Gaza City lost approximately 91% of its nighttime illumination within months. The satellite record provided a continuously updated, territory-wide picture of infrastructure collapse during a period of severely restricted ground access. 

<img width="1999" height="1267" alt="image1" src="https://github.com/user-attachments/assets/b8e20f98-f1c5-49c8-9586-a6fa26e62096" />

**Ukraine (2022–present):** The Russian invasion produced detectable changes from orbit within days. The city of Sumy saw nighttime light drop approximately 86% in the early weeks of the invasion. As the war progressed, systematic targeting of Ukraine's power grid produced further documented darkening. The Payne Institute at Colorado School of Mines developed a dedicated Dimming Lights Ratio methodology to track changes. Notably, the 40-mile Russian military convoy near Kyiv in early 2022 was visible as an anomalous new light source — evidence of poor light discipline.

<img width="1999" height="1274" alt="image10" src="https://github.com/user-attachments/assets/6723652f-b924-4aa4-88dd-b99c50708064" />

**Luttelgeest, Netherlands (2014–2023):** The Netherlands recorded a 37% decline in nighttime light over this period — one of the sharpest drops for any stable, prosperous country in the VIIRS era. The cause was not conflict or economic collapse but LED transition and energy price responses to the 2022 European gas crisis. Dutch greenhouse operators accelerated their switch to LED grow lighting, which VIIRS underdetects. This case is included as a direct demonstration of the LED limitation: the change detection layer shows significant dimming, but the country's economy and agricultural output were unaffected.

<img width="1999" height="1272" alt="image6" src="https://github.com/user-attachments/assets/6e86f70f-707f-472a-bf8c-714508f3806a" />

**Thai–Myanmar border (2021–present):** Following Myanmar's 2021 coup, displacement across the Thai border increased significantly. Light increases around Mae Sot and known border camp areas provide satellite-based corroboration of UNHCR ground reporting on population movements.

<img width="1999" height="1265" alt="image9" src="https://github.com/user-attachments/assets/a879018f-559c-43d4-83a1-f8652dfbd75b" />

**Default region and political neutrality.** The tool opens by default on the Gaza Strip as a demonstration of the most extensively documented case of nighttime light collapse in the VIIRS record. This reflects the strength of the available data and analysis. The tool can be used to analyse any location on Earth and makes no claims about attribution, responsibility, or ground conditions beyond what the satellite record directly shows.

---

## Export

Detected change areas can be downloaded from the tool as centre points (GeoJSON, CSV, KML), outlines (GeoJSON) and the analysed area (GeoJSON). In the Code Editor they can also be exported to Google Drive. Each record includes:

- `direction` and `change_band` (for example `decrease >70%`), describing the size of the change, not its cause
- `mean_change_pct`, `pixel_count`, `area_km2` and the radiance sums for both periods, all from the area's own pixels
- `centroid_lon`, `centroid_lat` and `cluster_id`
- the dates, dataset, thresholds and quality settings used, so every file can be traced back to the run that made it

Note: export links are time-limited signed URLs generated by Google Earth Engine. They expire within a few hours of generation and do not expose any authentication credentials.

---

## Running costs

The tool runs entirely within Google Earth Engine's free research tier. There is no hosting cost and no API cost for standard use. Large AOI analyses may approach free-tier compute limits; if the tool returns a timeout error, reduce the analysis area and rerun.

---

## Citation

If you use this tool in published work, please cite:

**Tool:** Strick, B. (2026). *Dark Light Viewer v3.4*. Available at: https://gee-night-lights-474517.projects.earthengine.app/view/darklight-viewer

**Underlying data:** NOAA/EOG. *VIIRS Day/Night Band Monthly Composites (VCMCFG; stray-light corrected VCMSLCFG)*. Distributed via Google Earth Engine.

---

## Contributing

Bug reports, suggested locations, and methodology questions are welcome via [GitHub Issues](https://github.com/bendobrown/Dark-Light-Viewer/issues).

---

## Licence

MIT Licence. See [LICENSE](LICENSE) for details.

---

## About

[Benjamin Strick](https://benjaminstrick.com) — OSINT investigator and geospatial analyst.  
For methodology questions, case study requests, or collaboration: [benjaminstrick.com](https://benjaminstrick.com)
