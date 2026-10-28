/**** Dark Light Viewer v3.4
     See how night-time lights have changed, anywhere on Earth.
     https://github.com/bendobrown/Dark-Light-Viewer

     How to run: paste this entire file into a new Google Earth Engine Code
     Editor script and click Run. No imports or private assets are needed.

     What it does
     - Compares night-time radiance between two periods of equal length and
       explains the result in plain language, with cautions where the data
       are thin or the result could mislead.
     - Months with no cloud-free observation are removed, so missing data is
       never read as darkness. Each later month is paired with the same
       calendar month in the earlier period, and a spot is compared only on
       months seen clearly in both (default: at least 75%, rounded up).
     - The headline figure is the change in total radiance across the same
       lit spots in both periods. No figure is given when too few spots can
       be compared.
     - Areas centred at 30 degrees latitude or more use the stray-light
       corrected product (VCMSLCFG) by default, which keeps summer months.
     - Change areas: rises and falls are grouped separately; statistics and
       size come from each area's own pixels (ee.Image.pixelArea()).
     - Area from the map view, an FAO GAUL 2015 boundary, a drawn shape or
       pasted GeoJSON. Links reproduce an analysis exactly.
     - Downloads: centre points (GeoJSON, CSV, KML), outlines (GeoJSON) and
       the analysed area, with dates and settings in every record.
     - Built-in self-tests: set RUN_TESTS to true and check the Console.

     Data: NOAA/EOG VIIRS Day/Night Band monthly composites (VCMCFG, and the
     stray-light corrected VCMSLCFG), ~464 m pixels, April 2012 onward.
     A radiance change is a measurement, not a cause.
     Privacy: aggregated radiance only. Cannot identify individuals.
****/

// ═══════════════════════════════════════
// 0) SETTINGS
// ═══════════════════════════════════════
var VERSION = '3.4';

// Set to true to print self-test results to the Console tab in the Code
// Editor. Keep false in a published App: the tests use Earth Engine compute.
var RUN_TESTS = false;

var DATASET_ID = 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG';   // Standard product; also sets archive dates.
// Both products share the native 15 arc-second grid. The corrected product
// keeps summer months at high latitudes but can carry twilight artefacts.
var DATASETS = {
  standard:  {id: DATASET_ID, code: 'VCMCFG', first: null,
              label: 'standard (VCMCFG)'},
  corrected: {id: 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG', code: 'VCMSLCFG', first: ymIndex(2014, 1),
              label: 'stray-light corrected (VCMSLCFG)'}
};
var AUTO_CORRECTED_LAT = 30;   // Auto mode uses the corrected product at or above this |latitude|.
var DEFAULT_MATCH_PCT = 75;    // Matched months needed, as % of the window (9 of 12).
var REPO_URL = 'https://github.com/bendobrown/Dark-Light-Viewer';

var MIN_COMPARED_PX = 25;      // Fewer compared lit pixels than this: no headline figure.
var SEA_SHARE_WARN = 25;       // % of lit pixels at sea above which the summary warns.
var PCT_CAP = 1000;           // % change cap used only for the percentile spread.
var PCT_FLOOR = 0.5;           // nW/cm²/sr. Denominator floor for % change.
var MAX_AOI_KM2 = 1000000;     // Larger areas are refused.
var WARN_AOI_KM2 = 200000;     // Larger areas get a "may be slow" warning.
var MAX_LINK_FEATURES = 5000;  // Above this, direct download links may fail.
var MAX_LINK_GEO_CHARS = 4000; // Longest drawn or pasted shape a link will store.
var NATIVE_SCALE_M = 463.83;   // Nominal pixel size of the VCMCFG grid.

// ═══════════════════════════════════════
// 1) DATA
// ═══════════════════════════════════════
var VIIRS_RAW = ee.ImageCollection(DATASET_ID);
var VIIRS_BY_CODE = {VCMCFG: VIIRS_RAW, VCMSLCFG: ee.ImageCollection(DATASETS.corrected.id)};

// Native 15 arc-second grid of the monthly composites. Every reduction and
// vectorisation runs on this grid, so pixel counts are exact, not resampled.
var GRID = ee.Image(VIIRS_RAW.first()).select('avg_rad').projection();

var GAUL = {
  '0': ee.FeatureCollection('FAO/GAUL/2015/level0'),
  '1': ee.FeatureCollection('FAO/GAUL/2015/level1'),
  '2': ee.FeatureCollection('FAO/GAUL/2015/level2')
};
var LSIB = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');

// ═══════════════════════════════════════
// 2) PALETTES AND SYMBOLS (colour-blind safe)
// ═══════════════════════════════════════
var PAL = {
  // inferno
  radiance: ['000004', '1b0c41', '4a0c6b', '781c6d', 'a52c60',
             'cf4446', 'ed6925', 'fb9b06', 'f7d13d', 'fcffa4'],
  // ColorBrewer BrBG: brown = decrease, teal = increase
  change: ['8c510a', 'bf812d', 'dfc27d', 'f6e8c3', 'f5f5f5',
           'c7eae5', '80cdc1', '35978f', '01665e'],
  // viridis
  coverage: ['440154', '3b528b', '21908d', '5dc863', 'fde725']
};

var COL = {
  aoi: 'ffff00',
  pendingAoi: 'ffffff',
  insufficient: '762a83',
  noData: '9e9e9e',
  decrease: '8c510a',
  increase: '01665e'
};

// Measured-change bands for detected areas. These describe the size of the
// radiance change only. They are not diagnoses of what caused it.
var CHANGE_BANDS = [
  {key: 'decrease >70%',    color: '543005'},
  {key: 'decrease 50-70%',  color: 'bf812d'},
  {key: 'decrease <50%',    color: 'f6e8c3'},
  {key: 'increase <50%',    color: 'c7eae5'},
  {key: 'increase 50-100%', color: '35978f'},
  {key: 'increase >100%',   color: '003c30'}
];
var POINT_STYLES = {};
var POLY_STYLES = {};
CHANGE_BANDS.forEach(function(b) {
  POINT_STYLES[b.key] = {color: '000000', fillColor: b.color, pointSize: 6,
                         pointShape: 'circle', width: 1};
  POLY_STYLES[b.key] = {color: b.color, fillColor: '00000000', width: 2};
});
var EE_POINT_STYLES = ee.Dictionary(POINT_STYLES);
var EE_POLY_STYLES = ee.Dictionary(POLY_STYLES);
var DEFAULT_POINT_STYLE = {color: '000000', fillColor: '999999', pointSize: 5,
                           pointShape: 'circle', width: 1};
var DEFAULT_POLY_STYLE = {color: '999999', fillColor: '00000000', width: 1};

// ═══════════════════════════════════════
// 3) COMPARISONS AND STORY LOCATIONS
// ═══════════════════════════════════════
// Preset comparisons are relative to the latest available month.
// months = window length; offset = how far the baseline window is shifted back.
var PERIODS = {
  y1:        {label: 'Last 12 months vs the 12 before', months: 12, offset: 12},
  m1:        {label: 'Latest month vs the month before', months: 1, offset: 1},
  yoy3:      {label: 'Last 3 months vs same 3 months a year earlier', months: 3, offset: 12},
  prev3:     {label: 'Last 3 months vs the 3 before', months: 3, offset: 3},
  y5:        {label: 'Last 12 months vs 12 months, 5 years earlier', months: 12, offset: 60},
  y10:       {label: 'Last 12 months vs 12 months, 10 years earlier', months: 12, offset: 120},
  m1overlap: {label: '3-month means one month apart (overlapping, smoothed)',
              months: 3, offset: 1, overlapping: true}
};
var PERIOD_ORDER = ['y1', 'm1', 'yoy3', 'prev3', 'y5', 'y10', 'm1overlap'];

// Event locations use a baseline that ENDS the month before the event, so no
// post-event months enter the baseline. The comparison is the latest window.
var STORY_PRESETS = [
  {name: 'Gaza Strip (from Oct 2023)', lon: 34.39, lat: 31.42, zoom: 11,
   baselineEnd: '2023-09', months: 12, admin: {level: '0', name: 'Gaza Strip'}},
  {name: 'Mariupol, Ukraine (from Feb 2022)', lon: 37.55, lat: 47.10, zoom: 11,
   baselineEnd: '2022-01', months: 12},
  {name: 'Kharkiv, Ukraine (from Feb 2022)', lon: 36.25, lat: 49.99, zoom: 10,
   baselineEnd: '2022-01', months: 12},
  {name: 'Khartoum, Sudan (from Apr 2023)', lon: 32.56, lat: 15.59, zoom: 10,
   baselineEnd: '2023-03', months: 12},
  {name: 'Lahaina, Hawaii (Aug 2023 wildfire)', lon: -156.68, lat: 20.88, zoom: 13,
   baselineEnd: '2023-07', months: 12},
  {name: 'Mosul, Iraq', lon: 43.14, lat: 36.34, zoom: 11, period: 'y5'},
  {name: "Sana'a, Yemen", lon: 44.21, lat: 15.35, zoom: 11, period: 'y5'},
  {name: 'New Administrative Capital, Egypt', lon: 31.75, lat: 30.02, zoom: 11, period: 'y5',
   dataset: 'standard'},   // sits on the 30° auto switch; pinned so runs stay comparable
  {name: 'Addis Ababa, Ethiopia', lon: 38.75, lat: 9.01, zoom: 10, period: 'y10'},
  {name: 'Luttelgeest, Netherlands (greenhouse lighting)',
   lon: 5.83, lat: 52.63, zoom: 12, period: 'y10'}
];

// ═══════════════════════════════════════
// 4) MONTHS AND WINDOWS (pure client-side logic, covered by self-tests)
// ═══════════════════════════════════════
var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MONTH_ITEMS = [
  {label: 'January', value: '01'}, {label: 'February', value: '02'},
  {label: 'March', value: '03'}, {label: 'April', value: '04'},
  {label: 'May', value: '05'}, {label: 'June', value: '06'},
  {label: 'July', value: '07'}, {label: 'August', value: '08'},
  {label: 'September', value: '09'}, {label: 'October', value: '10'},
  {label: 'November', value: '11'}, {label: 'December', value: '12'}
];

function pad2(n) { return (n < 10 ? '0' : '') + n; }
// Months are handled as integer indexes: year * 12 + (month - 1).
function ymIndex(y, m) { return y * 12 + (m - 1); }
function idxYear(i) { return Math.floor(i / 12); }
function idxMonth(i) { return (i % 12) + 1; }
function idxToYM(i) { return idxYear(i) + '-' + pad2(idxMonth(i)); }
function idxToDate(i) { return idxToYM(i) + '-01'; }
function idxLabel(i) { return MONTH_ABBR[idxMonth(i) - 1] + ' ' + idxYear(i); }

function parseYM(s) {
  var m = /^(\d{4})-(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  var mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return ymIndex(Number(m[1]), mo);
}

var ARCHIVE_FIRST = ymIndex(2012, 4);

// A window is {start, end, months}; start and end are both INCLUDED.
function makeWindow(endIdx, months) {
  return {start: endIdx - months + 1, end: endIdx, months: months};
}
// Earth Engine filterDate range: end date is exclusive.
function windowRange(w) { return [idxToDate(w.start), idxToDate(w.end + 1)]; }
function windowSpan(w) {
  return w.start === w.end ? idxLabel(w.start) : idxLabel(w.start) + ' to ' + idxLabel(w.end);
}
function windowLabel(w) {
  return windowSpan(w) + ' (' + w.months + ' mo)';
}
function windowText(w) {
  return windowSpan(w) + ' (' + w.months + ' month' + (w.months > 1 ? 's' : '') + ')';
}
function minValidMonths(months, pct) {
  return Math.max(1, Math.ceil(months * pct / 100 - 1e-9));
}

// Pairs each comparison month with a baseline month. When both windows
// cover the same calendar months, months are paired by calendar month
// (Sep with Sep), so the two means always sample the same seasons. Otherwise
// (for example latest month vs the month before) they are paired in order
// and calendar is false.
function pairMonths(win) {
  var b = win.base, c = win.cur, pairs = [], byCal = {}, used = {}, k, m;
  for (k = b.start; k <= b.end; k++) {
    m = idxMonth(k);
    (byCal[m] = byCal[m] || []).push(k);
  }
  var calendar = b.months === c.months;
  for (k = c.start; calendar && k <= c.end; k++) {
    m = idxMonth(k);
    var u = used[m] || 0;
    if (!byCal[m] || u >= byCal[m].length) { calendar = false; break; }
    pairs.push([byCal[m][u], k]);
    used[m] = u + 1;
  }
  if (!calendar) {
    pairs = [];
    for (k = 0; k < c.months; k++) pairs.push([b.start + k, c.start + k]);
  }
  return {pairs: pairs, calendar: calendar};
}

function nearSwitch(lat) {
  return Math.abs(lat - AUTO_CORRECTED_LAT) < 1
    ? '; close to the 30° switch, so pick a dataset under Data quality to keep runs comparable'
    : '';
}

// choice: 'auto' | 'standard' | 'corrected'. Returns {ds, note, fallback}
// or {error}.
function resolveDataset(choice, win, centreLat) {
  var corrOk = win.base.start >= DATASETS.corrected.first &&
               win.cur.start >= DATASETS.corrected.first &&
               (state.latestCorrected === null || state.latestCorrected === undefined ||
                win.cur.end <= state.latestCorrected);
  if (choice === 'standard') return {ds: DATASETS.standard, note: 'chosen manually'};
  if (choice === 'corrected') {
    if (!corrOk) {
      return {error: 'The stray-light corrected product covers ' + idxLabel(DATASETS.corrected.first) +
        ' to ' + (isNum(state.latestCorrected) ? idxLabel(state.latestCorrected) : 'its latest month') +
        ', which does not include ' + windowSpan(win.base) + ' and ' + windowSpan(win.cur) +
        '. Choose the standard product or other dates.'};
    }
    return {ds: DATASETS.corrected, note: 'chosen manually'};
  }
  var lat = Math.abs(centreLat);
  if (isNum(lat) && lat >= AUTO_CORRECTED_LAT) {
    if (corrOk) {
      return {ds: DATASETS.corrected, note: 'auto: area centred at ' + lat.toFixed(1) +
        '°, where the standard product often loses summer months' + nearSwitch(lat)};
    }
    return {ds: DATASETS.standard, fallback: true, note: 'auto: the corrected product does not ' +
      'cover these dates (it starts Jan 2014' + (isNum(state.latestCorrected) ? ' and ends ' +
      idxLabel(state.latestCorrected) : '') + '), so the standard product is used; summer months ' +
      'at this latitude will be missing'};
  }
  return {ds: DATASETS.standard, note: 'auto: area centred below ' + AUTO_CORRECTED_LAT + '°' +
    (isNum(lat) ? nearSwitch(lat) : '')};
}

// spec: {type: 'preset', key} or
//       {type: 'custom', baselineEnd, currentEnd, months, allowOverlap}
function buildWindows(spec, latestIdx) {
  if (latestIdx === null || latestIdx === undefined) {
    return {error: 'Archive dates are still loading.'};
  }
  var cur, base, overlapAllowed;
  if (spec.type === 'preset') {
    var p = PERIODS[spec.key];
    if (!p) return {error: 'Unknown comparison "' + spec.key + '".'};
    cur = makeWindow(latestIdx, p.months);
    base = makeWindow(latestIdx - p.offset, p.months);
    overlapAllowed = !!p.overlapping;
  } else if (spec.type === 'custom') {
    if (spec.baselineEnd === null || spec.currentEnd === null ||
        spec.baselineEnd === undefined || spec.currentEnd === undefined) {
      return {error: 'Choose the last month of both windows.'};
    }
    if (!(spec.months >= 1)) return {error: 'Choose a window length.'};
    cur = makeWindow(spec.currentEnd, spec.months);
    base = makeWindow(spec.baselineEnd, spec.months);
    overlapAllowed = !!spec.allowOverlap;
  } else {
    return {error: 'Unknown comparison type.'};
  }
  var err = validateWindows(cur, base, latestIdx, overlapAllowed);
  if (err) return {error: err};
  return {cur: cur, base: base, overlap: Math.max(0, base.end - cur.start + 1), spec: spec};
}

function validateWindows(cur, base, latestIdx, overlapAllowed) {
  if (base.start < ARCHIVE_FIRST) {
    return 'The baseline would start in ' + idxLabel(base.start) +
           ', before the archive begins (' + idxLabel(ARCHIVE_FIRST) + ').';
  }
  if (cur.start < ARCHIVE_FIRST) {
    return 'The comparison window would start in ' + idxLabel(cur.start) +
           ', before the archive begins (' + idxLabel(ARCHIVE_FIRST) + ').';
  }
  if (cur.end > latestIdx) {
    return 'The comparison window would end in ' + idxLabel(cur.end) +
           ', after the latest available month (' + idxLabel(latestIdx) + ').';
  }
  if (base.end > latestIdx) {
    return 'The baseline would end in ' + idxLabel(base.end) +
           ', after the latest available month (' + idxLabel(latestIdx) + ').';
  }
  if (base.end >= cur.end) {
    return 'The baseline must end before the comparison window. Baseline ends ' +
           idxLabel(base.end) + '; comparison ends ' + idxLabel(cur.end) + '.';
  }
  var overlap = base.end - cur.start + 1;
  if (overlap > 0 && !overlapAllowed) {
    return 'The windows overlap by ' + overlap + ' month' + (overlap > 1 ? 's' : '') +
           '. End the baseline in ' + idxLabel(cur.start - 1) + ' or earlier.';
  }
  return null;
}

// ═══════════════════════════════════════
// 5) SMALL HELPERS
// ═══════════════════════════════════════
// Request tokens: each kind of async request records its latest token, and a
// callback whose token is no longer current is ignored.
var TOKENS = {};
function newToken(kind) { TOKENS[kind] = (TOKENS[kind] || 0) + 1; return TOKENS[kind]; }
function isCurrent(kind, t) { return TOKENS[kind] === t; }

function isNum(n) { return typeof n === 'number' && isFinite(n); }
function fmt(n, dp) { return isNum(n) ? n.toFixed(dp === undefined ? 1 : dp) : 'n/a'; }
function fmtSigned(n, dp) {
  if (!isNum(n)) return 'n/a';
  return (n > 0 ? '+' : '') + n.toFixed(dp === undefined ? 1 : dp);
}
function fmtInt(n) {
  if (!isNum(n)) return 'n/a';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; }
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 90);
}
function coordTag(lon, lat) {
  function part(v, pos, neg) {
    return Math.abs(v).toFixed(2).replace('.', 'p') + (v >= 0 ? pos : neg);
  }
  return part(lon, 'E', 'W') + '_' + part(lat, 'N', 'S');
}
function clampNum(v, lo, hi, dflt) {
  var n = Number(v);
  if (v === null || v === undefined || v === '' || !isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// Earth Engine error text without a trailing full stop, so messages can add their own.
function errText(e, fallback) {
  return String(e || fallback || 'no response').replace(/[.\s]+$/, '');
}

function getViewBBox(map) {
  var bnds = map.getBounds();
  if (bnds === null || bnds === undefined) return null;
  if (Array.isArray(bnds) && bnds.length === 4 && isFinite(bnds[0])) return bnds;
  if (typeof bnds === 'object' && bnds.coordinates) {
    var coords = bnds.coordinates[0];
    var lons = coords.map(function(c) { return c[0]; });
    var lats = coords.map(function(c) { return c[1]; });
    return [Math.min.apply(null, lons), Math.min.apply(null, lats),
            Math.max.apply(null, lons), Math.max.apply(null, lats)];
  }
  return null;
}

function boundsToGeometry(bbox) {
  var w = Math.max(-180, Math.min(180, bbox[0]));
  var s = Math.max(-90, Math.min(90, bbox[1]));
  var e = Math.max(-180, Math.min(180, bbox[2]));
  var n = Math.max(-90, Math.min(90, bbox[3]));
  if (e < w) e = w + (360 - (w - e));   // crosses the antimeridian
  var eps = 1e-6;
  if (Math.abs(e - w) < eps) e = w + eps;
  if (Math.abs(n - s) < eps) n = s + eps;
  return ee.Geometry.Rectangle([w, s, e, n], 'EPSG:4326', false);
}

function roundBbox(b, dp) {
  return b.map(function(v) { return Number(v.toFixed(dp)); });
}

// Bounding box [w, s, e, n] from polygon coordinates [[[lon, lat], ...]].
function bboxFromRing(coords) {
  var ring = coords && coords[0];
  if (!ring || !ring.length) return null;
  var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  ring.forEach(function(c) {
    w = Math.min(w, c[0]); e = Math.max(e, c[0]);
    s = Math.min(s, c[1]); n = Math.max(n, c[1]);
  });
  return roundBbox([w, s, e, n], 4);
}

function outlineImage(geom, color) {
  return ee.FeatureCollection([ee.Feature(geom)])
    .style({color: color, fillColor: '00000000', width: 2});
}

// Accepts a Polygon, MultiPolygon, Feature or FeatureCollection.
function parseGeoJsonAoi(text) {
  if (!text || !String(text).trim()) {
    return {error: 'Paste a GeoJSON Polygon, MultiPolygon, Feature or FeatureCollection.'};
  }
  if (String(text).length > 2000000) {
    return {error: 'The GeoJSON is larger than 2 MB. Simplify it first.'};
  }
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return {error: 'That is not valid JSON (' + e.message + ').'};
  }
  var geoms = [];
  function addGeom(g) {
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && g.coordinates) {
      geoms.push(g);
    }
  }
  if (obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    obj.features.forEach(function(f) { addGeom(f && f.geometry); });
  } else if (obj && obj.type === 'Feature') {
    addGeom(obj.geometry);
  } else {
    addGeom(obj);
  }
  if (!geoms.length) {
    return {error: 'No Polygon or MultiPolygon found. Points and lines have no area.'};
  }
  var feats = geoms.map(function(g) {
    return ee.Feature(ee.Geometry(g, 'EPSG:4326', g.geodesic === true));
  });
  return {
    geometry: ee.FeatureCollection(feats).geometry(),
    summary: geoms.length + ' polygon' + (geoms.length > 1 ? 's' : '')
  };
}

function roundCoords(c, dp) {
  return Array.isArray(c) ? c.map(function(x) { return roundCoords(x, dp); })
                          : Number(Number(c).toFixed(dp));
}

// A drawn or pasted shape as short GeoJSON text for a link, or null if it is
// not a polygon or is too detailed to fit. Coordinates are rounded to 5
// decimal places (about 1 m).
function compactGeoJson(g) {
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !g.coordinates) return null;
  var out = {type: g.type, coordinates: roundCoords(g.coordinates, 5)};
  if (g.geodesic === true) out.geodesic = true;
  var text = JSON.stringify(out);
  return text.length <= MAX_LINK_GEO_CHARS ? text : null;
}

// ═══════════════════════════════════════
// 6) CORE EARTH ENGINE LOGIC
// ═══════════════════════════════════════

// Masks each monthly value that rests on fewer than minObs cloud-free
// observations. In VCMCFG a month with no observations reads as zero
// radiance, which would otherwise look like darkness.
function applyQuality(ic, minObs) {
  return ic.map(function(img) {
    return img.select('avg_rad').updateMask(img.select('cf_cvg').gte(minObs));
  });
}

// A fully masked seed keeps the band schema when the archive window is empty.
// It never contributes a radiance value or a valid-month count.
function maskedSeed() {
  return ee.Image.constant(0).toFloat().rename('avg_rad')
    .updateMask(ee.Image(0)).setDefaultProjection(GRID);
}

function windowComposite(ic) {
  var safe = ic.map(function(img) { return img.toFloat(); })
    .merge(ee.ImageCollection([maskedSeed()]));
  return {
    mean: safe.mean().rename('mean_rad').setDefaultProjection(GRID),
    count: safe.count().unmask(0).setDefaultProjection(GRID)
  };
}

// One month of a quality-masked collection; fully masked if the month is
// missing or has no valid observation.
function monthImage(ic, idx) {
  return ic.filterDate(idxToDate(idx), idxToDate(idx + 1))
    .map(function(img) { return img.toFloat(); })
    .merge(ee.ImageCollection([maskedSeed()])).mean().rename('avg_rad');
}

// Means over paired months that are valid in BOTH windows, and the number
// of such matched months per pixel.
function matchedMeans(baseIC, curIC, pairs) {
  var col = ee.ImageCollection(pairs.map(function(p) {
    var b = monthImage(baseIC, p[0]);
    var c = monthImage(curIC, p[1]);
    var both = b.mask().and(c.mask());
    return ee.Image.cat([b.updateMask(both).rename('b'), c.updateMask(both).rename('c'),
                         both.toInt().rename('m')]);
  }));
  return {
    base: col.select('b').mean().rename('mean_rad').setDefaultProjection(GRID),
    cur: col.select('c').mean().rename('mean_rad').setDefaultProjection(GRID),
    n: col.select('m').sum().unmask(0).setDefaultProjection(GRID)
  };
}

function reduceIn(img, reducer, region) {
  return img.reduceRegion({
    reducer: reducer, geometry: region, crs: GRID, maxPixels: 1e10, tileScale: 2
  });
}

// Builds every image and summary for one analysis. Nothing is computed until
// a layer is drawn or a value is evaluated.
function computeAnalysis(region, win, s, ds) {
  ds = ds || DATASETS.standard;
  var src = VIIRS_BY_CODE[ds.code];
  var cr = windowRange(win.cur);
  var br = windowRange(win.base);
  var curIC = applyQuality(src.filterDate(cr[0], cr[1]), s.minObs);
  var baseIC = applyQuality(src.filterDate(br[0], br[1]), s.minObs);

  var cw = windowComposite(curIC);
  var bw = windowComposite(baseIC);
  var nCur = cw.count.rename('n_cur');
  var nBase = bw.count.rename('n_base');

  // Calendar-month matching: a month counts only if it is valid in both
  // windows, so the two means sample the same seasons.
  var pairing = pairMonths(win);
  var mm = matchedMeans(baseIC, curIC, pairing.pairs);
  var cur = mm.cur;
  var base = mm.base;
  var nMatched = mm.n.rename('n_matched');

  // A pixel is compared only if enough months are matched.
  var minValid = minValidMonths(win.cur.months, s.minValidPct);
  var enough = nMatched.gte(minValid).rename('enough');
  // At least one cloud-free observation in both windows.
  var dataBoth = nCur.gt(0).and(nBase.gt(0)).rename('data_both');

  // Fixed footprint for this comparison: lit in EITHER window, so new
  // developments and lost lights are both included.
  var landAll = ee.Image(0).paint(LSIB.filterBounds(region), 1);
  var land = s.excludeOffshore ? landAll : ee.Image(1);
  // Uses every valid month, so a lit pixel with too few matched months is
  // shown as insufficient rather than dropped as unlit.
  var lit = cw.mean.unmask(0).gt(s.litThreshold)
    .or(bw.mean.unmask(0).gt(s.litThreshold));
  var footprint = lit.and(land).rename('footprint');
  var analysable = footprint.and(enough).rename('analysable');
  // Unknown: no light where observed, but a window has no cloud-free
  // observation at all, so light there cannot be ruled out. These pixels are
  // counted and shown, never treated as dark.
  var noData = lit.not().and(dataBoth.not()).and(land).rename('no_data');

  var diff = cur.subtract(base);
  var pctRaw = diff.divide(base.max(PCT_FLOOR)).multiply(100).rename('pct_change');
  var pct = pctRaw.updateMask(analysable);
  var abs = diff.rename('abs_change').updateMask(analysable);
  var insufficient = footprint.and(enough.not()).selfMask().rename('insufficient');

  var sums = reduceIn(
    ee.Image.cat([cur.rename('cur'), base.rename('base')]).updateMask(analysable),
    ee.Reducer.sum(), region);
  // Percentiles use a histogram on large areas. Very dim pixels can show
  // changes of thousands of percent (floored denominator), which stretched the
  // buckets so wide that p50 and p90 merged. Capping the values and fixing the
  // bucket width keeps the spread readable. A cap of +1000% is shown as such.
  var dist = reduceIn(pct.clamp(-100, PCT_CAP),
                      ee.Reducer.percentile({percentiles: [10, 50, 90], maxBuckets: 4096,
                                             minBucketWidth: 0.5}), region);
  // Lit pixels at sea (outside LSIB land), used to warn about boats and platforms.
  var litSea = lit.and(landAll.not()).rename('lit_sea');
  var counts = reduceIn(ee.Image.cat([footprint, analysable, dataBoth, noData, lit.rename('lit_all'),
                                      litSea, ee.Image(1).rename('all')]),
                        ee.Reducer.sum().unweighted(), region);
  var months = reduceIn(ee.Image.cat([nCur, nBase, nMatched]).updateMask(footprint),
                        ee.Reducer.mean(), region);

  var summary = ee.Dictionary({
    sum_cur: sums.get('cur'),
    sum_base: sums.get('base'),
    p10: dist.get('pct_change_p10'),
    p50: dist.get('pct_change_p50'),
    p90: dist.get('pct_change_p90'),
    n_footprint: counts.get('footprint'),
    n_analysable: counts.get('analysable'),
    n_all: counts.get('all'),
    n_data_both: counts.get('data_both'),
    n_no_data: counts.get('no_data'),
    n_lit_all: counts.get('lit_all'),
    n_lit_sea: counts.get('lit_sea'),
    mean_valid_cur: months.get('n_cur'),
    mean_valid_base: months.get('n_base'),
    mean_matched: months.get('n_matched'),
    n_images_cur: curIC.size(),
    n_images_base: baseIC.size()
  });

  return {
    region: region, cur: cur, base: base, nCur: nCur, nBase: nBase, nMatched: nMatched,
    pairing: pairing, dataset: ds,
    enough: enough, footprint: footprint, analysable: analysable,
    pctRaw: pctRaw, pct: pct, abs: abs, insufficient: insufficient,
    dataBoth: dataBoth, noData: noData,
    summary: summary, minValid: minValid
  };
}

// Change in the sum of pixel radiances over the same analysable grid cells.
// This is a radiance index, not emitted power, population or electricity use.
function solChange(s) {
  if (!s || !isNum(s.sum_base) || !(s.sum_base > 0) || !isNum(s.sum_cur)) return null;
  return (s.sum_cur - s.sum_base) / s.sum_base * 100;
}

// Change areas: one class per direction, vectorised directly on the native
// grid. reduceToVectors needs no object-size setting, and it computes each
// area's statistics in the same pass, over its member pixels only.
// A pixel counts as changed only if BOTH its % change and its absolute change
// pass their thresholds, so noise near zero cannot read as a large % change.
function buildClusters(pct, abs, cur, base, region, threshold, minPx, minAbs) {
  var dec = pct.lte(-threshold).and(abs.lte(-minAbs));
  var inc = pct.gte(threshold).and(abs.gte(minAbs));
  var cls = ee.Image(0)
    .where(dec, 1)
    .where(inc, 2)
    .selfMask()
    .toInt()
    .rename('change_class')
    .setDefaultProjection(GRID);

  var statsImg = ee.Image.cat([
    pct.rename('pct'),
    cur.rename('cur'),
    base.rename('base'),
    ee.Image.pixelArea().divide(1e6).rename('area_km2')
  ]);
  // One reducer per stats band; outputs are named <band>_mean, <band>_sum
  // and <band>_count.
  var reducer = ee.Reducer.mean()
    .combine({reducer2: ee.Reducer.sum(), sharedInputs: true})
    .combine({reducer2: ee.Reducer.count(), sharedInputs: true})
    .forEach(['pct', 'cur', 'base', 'area_km2']);

  var vectors = cls.addBands(statsImg).reduceToVectors({
    reducer: reducer,
    geometry: region,
    crs: GRID,
    geometryType: 'polygon',
    eightConnected: true,
    labelProperty: 'change_class',
    maxPixels: 1e10,
    tileScale: 2
  }).filter(ee.Filter.gte('pct_count', minPx));

  var polygons = vectors.map(function(f) {
    var geom = f.geometry();
    var cl = ee.Number(f.get('change_class'));
    var m = f.get('pct_mean');
    var band = ee.Algorithms.If(ee.Algorithms.IsEqual(m, null), 'no data',
      ee.Algorithms.If(cl.eq(1),
        ee.Algorithms.If(ee.Number(m).lte(-70), 'decrease >70%',
          ee.Algorithms.If(ee.Number(m).lte(-50), 'decrease 50-70%', 'decrease <50%')),
        ee.Algorithms.If(ee.Number(m).gte(100), 'increase >100%',
          ee.Algorithms.If(ee.Number(m).gte(50), 'increase 50-100%', 'increase <50%'))));
    var c = geom.centroid(1).coordinates();
    return f.set({
      cluster_id: f.get('system:index'),
      direction: ee.Algorithms.If(cl.eq(1), 'decrease', 'increase'),
      change_band: band,
      mean_change_pct: m,
      pixel_count: f.get('pct_count'),
      area_km2: f.get('area_km2_sum'),
      radiance_sum_baseline: f.get('base_sum'),
      radiance_sum_comparison: f.get('cur_sum'),
      centroid_lon: c.get(0),
      centroid_lat: c.get(1),
      style_point: EE_POINT_STYLES.get(band, DEFAULT_POINT_STYLE),
      style_poly: EE_POLY_STYLES.get(band, DEFAULT_POLY_STYLE)
    });
  });

  return {classImage: cls, polygons: polygons};
}

// Display label for a change band; '<50%' bands start at the threshold.
function bandLabel(key, thr) {
  return key.indexOf('<50%') >= 0 ? key.replace('<50%', thr + '-50%') : key;
}

var CLUSTER_FIELDS = [
  'cluster_id', 'direction', 'change_band', 'mean_change_pct', 'pixel_count',
  'area_km2', 'radiance_sum_baseline', 'radiance_sum_comparison',
  'centroid_lon', 'centroid_lat'
];

// Method settings written into every exported feature.
function analysisProvenance(a) {
  return {
    dlv_version: VERSION,
    dataset: a.dataset.id,
    dataset_choice: a.settings.dataset,
    grid: 'VIIRS DNB monthly native 15 arc-second',
    baseline_start: idxToYM(a.windows.base.start),
    baseline_end: idxToYM(a.windows.base.end),
    comparison_start: idxToYM(a.windows.cur.start),
    comparison_end: idxToYM(a.windows.cur.end),
    window_months: a.windows.cur.months,
    min_cf_obs_per_month: a.settings.minObs,
    min_matched_months: a.minValid,
    min_matched_months_pct: a.settings.minValidPct,
    month_pairing: a.pairing.calendar ? 'calendar month' : 'in order',
    temporal_aggregation: 'unweighted mean over paired months valid in both windows',
    spatial_aggregation: 'sum of radiance on the same native grid cells; not emitted power',
    footprint_rule: 'lit in either window; sufficient coverage in both',
    lit_threshold_nw: a.settings.litThreshold,
    pct_floor_nw: PCT_FLOOR,
    exclude_offshore: a.settings.excludeOffshore ? 1 : 0,
    aoi: a.aoi.desc,
    aoi_bbox: a.aoi.bbox ? a.aoi.bbox.join(',') : '',
    generated_utc: a.generatedUtc
  };
}

function detectionProvenance(a, snap) {
  var p = analysisProvenance(a);
  p.threshold_pct = snap.threshold;
  p.min_cluster_px = snap.minPx;
  p.min_abs_change_nw = snap.minAbs;
  return p;
}

// ═══════════════════════════════════════
// 7) STATE
// ═══════════════════════════════════════
var state = {
  latest: null,            // month index of the latest composite (standard product)
  latestCorrected: null,   // latest month of the stray-light corrected product, once read
  analysis: null,          // last analysis started (with its settings snapshot)
  analysisStale: false,    // settings changed since that analysis
  staleReason: '',
  detection: null,         // last detection, tied to one analysis
  aoiByKind: {admin: null, geojson: null},
  awaitingAdminPick: false,
  activePreset: null,
  opacityLayers: [],
  aoiSeq: 0,               // id for each selected admin or GeoJSON area
  drawVersion: 0,          // bumped whenever a drawn shape changes
  drawing: false,          // true while the user is drawing a shape
  checking: false          // true while a new analysis's area is being checked
};

// ═══════════════════════════════════════
// 8) MAPS AND LAYOUT
// ═══════════════════════════════════════
var leftMap = ui.Map();
var rightMap = ui.Map();
leftMap.setOptions('HYBRID');
rightMap.setOptions('SATELLITE');
leftMap.setCenter(34.39, 31.42, 10);
rightMap.setCenter(34.39, 31.42, 10);
ui.Map.Linker([leftMap, rightMap]);

var split = ui.SplitPanel({
  firstPanel: leftMap,
  secondPanel: rightMap,
  orientation: 'horizontal',
  wipe: true,
  style: {stretch: 'both', height: '100%'}
});
ui.root.widgets().reset([split]);
ui.root.setLayout(ui.Panel.Layout.flow('vertical'));

[leftMap, rightMap].forEach(function(m) {
  m.setControlVisibility({drawingToolsControl: false, mapTypeControl: false});
});
var drawingTools = leftMap.drawingTools();
drawingTools.setShown(false);

// ═══════════════════════════════════════
// 9) WIDGETS
// ═══════════════════════════════════════
var S_SMALL = {fontSize: '11px', color: '#555', margin: '2px 0'};
var S_HINT = {fontSize: '10px', color: '#777', margin: '0 0 4px 0', whiteSpace: 'pre-wrap'};
var S_FIELD = {fontSize: '12px', fontWeight: 'bold', margin: '8px 0 2px 0'};

function section(title, widgets, open) {
  var body = ui.Panel({widgets: widgets, style: {shown: !!open, margin: '0 0 4px 0'}});
  var btn = ui.Button({
    label: (open ? '▼ ' : '▶ ') + title,
    style: {stretch: 'horizontal', margin: '6px 0 0 0'}
  });
  btn.onClick(function() {
    var show = !body.style().get('shown');
    body.style().set('shown', show);
    btn.setLabel((show ? '▼ ' : '▶ ') + title);
  });
  return ui.Panel([btn, body]);
}

function hrow(widgets) {
  return ui.Panel({widgets: widgets, layout: ui.Panel.Layout.flow('horizontal'),
                   style: {margin: '0', stretch: 'horizontal'}});
}

// --- Header and status ---
var headerPanel = ui.Panel([
  ui.Label('🔦 Dark Light Viewer', {fontWeight: 'bold', fontSize: '20px', margin: '0'}),
  ui.Label('See how night-time lights have changed', {fontSize: '13px', color: '#666', margin: '0'})
]);
var archiveLabel = ui.Label('Reading the VIIRS archive...', S_HINT);

var statusLabel = ui.Label('', {fontSize: '12px', margin: '6px 0', whiteSpace: 'pre-wrap'});
var STATUS_STYLE = {
  working: {icon: '⏳ ', color: '#e65100'},
  ok: {icon: '✅ ', color: '#2e7d32'},
  insufficient: {icon: '⚠️ ', color: '#8a6d00'},
  failed: {icon: '❌ ', color: '#c62828'},
  info: {icon: 'ℹ️ ', color: '#1565c0'}
};
function setStatus(kind, text) {
  var st = STATUS_STYLE[kind] || {icon: '', color: '#333'};
  statusLabel.setValue(st.icon + text);
  statusLabel.style().set('color', st.color);
}

var analyzeBtn = ui.Button({
  label: '▶  ANALYSE',
  style: {stretch: 'horizontal', fontWeight: 'bold', padding: '4px 0'}
});
analyzeBtn.setDisabled(true);

var resultsPanel = ui.Panel({
  style: {backgroundColor: '#f8f9fa', padding: '6px', margin: '6px 0', shown: false}
});
// Plain-language headline, shown at the top of the panel after an analysis.
var summaryPanel = ui.Panel({
  style: {backgroundColor: '#fff8e1', padding: '6px', margin: '4px 0', shown: false}
});

// --- Area of interest ---
var aoiModeSelect = ui.Select({
  items: [
    {label: 'Current map view (rectangle)', value: 'view'},
    {label: 'Admin boundary (click the map)', value: 'admin'},
    {label: 'Draw a shape', value: 'draw'},
    {label: 'Paste GeoJSON', value: 'geojson'}
  ],
  value: 'view',
  style: {stretch: 'horizontal'}
});
var aoiInfo = ui.Label('', S_HINT);

var adminLevelSelect = ui.Select({
  items: [
    {label: 'Country (GAUL level 0)', value: '0'},
    {label: 'Province or state (level 1)', value: '1'},
    {label: 'District (level 2)', value: '2'}
  ],
  value: '1',
  style: {stretch: 'horizontal'}
});
var adminPickBtn = ui.Button({label: '👆 Pick area on map', style: {stretch: 'horizontal'}});
var adminPanel = ui.Panel({
  widgets: [adminLevelSelect, adminPickBtn,
            ui.Label('FAO GAUL 2015 boundaries. Some are outdated or disputed; ' +
                     'record which boundary you used.', S_HINT)],
  style: {shown: false, margin: '0'}
});

var drawBtn = ui.Button({label: '✏ Draw a shape', style: {stretch: 'horizontal'}});
var clearDrawBtn = ui.Button({label: '🗑 Clear drawing', style: {stretch: 'horizontal'}});
var drawPanel = ui.Panel({
  widgets: [ui.Label('Draw a polygon or rectangle on the map, on the left of the ' +
                     'divider. Several shapes are combined. Once a shape is finished, ' +
                     'map clicks open the pixel chart again.', S_HINT),
            hrow([drawBtn, clearDrawBtn])],
  style: {shown: false, margin: '0'}
});

var geojsonBox = ui.Textbox({
  placeholder: 'Paste a GeoJSON Polygon, Feature or FeatureCollection',
  style: {stretch: 'horizontal'}
});
var useGeojsonBtn = ui.Button({label: 'Use this GeoJSON', style: {stretch: 'horizontal'}});
var geojsonPanel = ui.Panel({
  widgets: [geojsonBox, useGeojsonBtn,
            ui.Label('Coordinates in WGS84 (EPSG:4326). Only polygons are used.', S_HINT)],
  style: {shown: false, margin: '0'}
});

// --- Comparison ---
var periodSelect = ui.Select({
  items: PERIOD_ORDER.map(function(k) { return {label: PERIODS[k].label, value: k}; }),
  value: 'y1',
  style: {stretch: 'horizontal'}
});
var customCheckbox = ui.Checkbox({label: 'Choose my own dates', value: false});
var baseYearSel = ui.Select({items: [], placeholder: 'Year', style: {stretch: 'horizontal'}});
var baseMonthSel = ui.Select({items: MONTH_ITEMS, value: '01', style: {stretch: 'horizontal'}});
var curYearSel = ui.Select({items: [], placeholder: 'Year', style: {stretch: 'horizontal'}});
var curMonthSel = ui.Select({items: MONTH_ITEMS, value: '01', style: {stretch: 'horizontal'}});
var lengthSel = ui.Select({
  items: [{label: '1 month', value: '1'}, {label: '3 months', value: '3'},
          {label: '6 months', value: '6'}, {label: '12 months', value: '12'}],
  value: '12',
  style: {stretch: 'horizontal'}
});
var overlapCheckbox = ui.Checkbox({
  label: 'Allow overlapping windows (smooths the change)',
  value: false,
  style: {fontSize: '11px'}
});
var customPanel = ui.Panel({
  widgets: [
    ui.Label('Earlier period ends in', S_SMALL),
    hrow([baseYearSel, baseMonthSel]),
    ui.Label('Later period ends in', S_SMALL),
    hrow([curYearSel, curMonthSel]),
    ui.Label('Months in each period', S_SMALL),
    lengthSel,
    overlapCheckbox,
    ui.Label('For an event, end the baseline the month BEFORE it. The baseline ' +
             'never includes later months.', S_HINT)
  ],
  style: {shown: false, margin: '0'}
});
var windowsPreview = ui.Label('', {fontSize: '11px', margin: '4px 0', whiteSpace: 'pre-wrap'});

// --- Story locations ---
var locationSelect = ui.Select({
  items: STORY_PRESETS.map(function(p, i) { return {label: p.name, value: String(i)}; }),
  placeholder: 'Choose a location...',
  style: {stretch: 'horizontal'}
});
locationSelect.setDisabled(true);   // enabled once the archive dates are known

// --- View ---
// ─── "What does this mean?" ─────────────────────────────────────────────
// Plain-language reading of each view. It says what a colour usually goes
// with and what else can cause it. It never states a cause: the tool
// measures light, not what produced it.
var EXPLAIN_NEXT = 'Treat the colours as a lead, not a finding. Before saying why the light ' +
  'changed, check dated satellite imagery, news and local reporting, and the coverage view.';
var EXPLAIN = {
  pct: {
    intro: 'How much brighter or darker each spot is at night, compared with the baseline.',
    keys: [
      ['35978f', 'Teal: more light at night. Often goes with new buildings, roads, industry or ' +
                 'more people. Can also be fires, gas flares, construction lighting or brighter lamps.'],
      ['bf812d', 'Brown: less light at night. Often goes with power cuts, damage, people leaving ' +
                 'or businesses closing. Can also be a switch to LED street lights, blackout rules ' +
                 'or energy saving.'],
      ['f5f5f5', 'Pale: little or no change.'],
      [null, 'Darker shades mean bigger changes.'],
      ['762a83', 'Purple: lit, but too few months to compare fairly. Missing data, not darkness.'],
      ['9e9e9e', 'Grey: no clear view in one of the periods. Unknown, not dark.']
    ],
    note: 'Percentages exaggerate change in very dim places: going from 0.6 to 1.2 is +100%. ' +
          'Switch to Absolute change to see where the big changes in light really are.'
  },
  abs: {
    intro: 'How much light was gained or lost at each spot, in the sensor\'s own units.',
    keys: [
      ['35978f', 'Teal: light gained. Brown: light lost. Same causes as the % view.'],
      ['bf812d', 'The strongest colours sit in bright places such as city centres, ports and ' +
                 'industrial sites, because they had the most light to gain or lose.'],
      ['762a83', 'Purple: lit, but too few months to compare. Grey: no clear view in a period.']
    ],
    note: 'A small town can show a big % change but a small absolute change. Use both views together.'
  },
  nodes: {
    intro: 'Areas where many neighbouring pixels changed by more than your threshold.',
    keys: [
      ['543005', 'Dark brown: light fell by more than 70%.'],
      ['f6e8c3', 'Pale brown: smaller falls.'],
      ['c7eae5', 'Pale teal: smaller rises.'],
      ['003c30', 'Dark teal: light more than doubled.']
    ],
    note: 'An area is a cluster of pixels, not a building or a site. Click inside one to see its ' +
          'monthly history before reading anything into it.'
  },
  current: {
    intro: 'How bright each spot was at night in the comparison period.',
    keys: [
      ['fcffa4', 'Yellow and white: bright. Usually city centres, main roads, ports, industry.'],
      ['cf4446', 'Red and orange: moderately lit. Suburbs, towns, smaller roads.'],
      ['000004', 'Black: dark or unlit.']
    ],
    note: 'Brightness tracks where lighting is, which often follows people and economic activity. ' +
          'It does not tell you how many people live there.'
  },
  baseline: {
    intro: 'How bright each spot was at night in the baseline period.',
    keys: [
      ['fcffa4', 'Yellow and white: bright. Red and orange: moderately lit. Black: dark.']
    ],
    note: 'Switch between this view and the comparison view to see the two periods side by side.'
  },
  composite: {
    intro: 'Both periods in one picture: the baseline in red, the comparison in green and blue.',
    keys: [
      ['ff0000', 'Red: brighter in the baseline. Light has been lost here.'],
      ['00ffff', 'Cyan: brighter now. Light has been gained here.'],
      ['ffffff', 'White: bright in both periods. Stable.'],
      ['000000', 'Black: dark in both periods.']
    ],
    note: 'Good for spotting the pattern at a glance. Use the % or absolute view for numbers.'
  },
  coverage: {
    intro: 'How many calendar months were seen clearly in BOTH periods. Only those months are compared.',
    keys: [
      ['fde725', 'Yellow: full data. Results here are the most reliable.'],
      ['21908d', 'Green and blue: some months missing.'],
      ['440154', 'Dark purple: few or no months. Missing data, not darkness.']
    ],
    note: 'Gaps come from cloud and, far from the equator, from summer nights that are too short ' +
          'to see. Check this view before trusting any result.'
  }
};

var explainOpen = false;
var explainPanel = ui.Panel({style: {shown: false, margin: '2px 0 4px 0', padding: '6px',
                                     backgroundColor: '#fff8e1'}});
var explainBtn = ui.Button({label: '❓ What does this mean?', style: {stretch: 'horizontal'}});
explainBtn.onClick(function() {
  explainOpen = !explainOpen;
  explainPanel.style().set('shown', explainOpen);
  explainBtn.setLabel(explainOpen ? '✕ Hide explanation' : '❓ What does this mean?');
  renderExplain(viewSelect.getValue());
});

function renderExplain(mode) {
  explainPanel.clear();
  var e = EXPLAIN[mode];
  if (!e) return;
  var T = {fontSize: '11px', margin: '2px 0', whiteSpace: 'pre-wrap'};
  explainPanel.add(ui.Label(e.intro, {fontSize: '11px', fontWeight: 'bold', margin: '0 0 4px 0',
                                      whiteSpace: 'pre-wrap'}));
  e.keys.forEach(function(k) {
    var text = ui.Label(k[1], {fontSize: '11px', margin: '2px 0', whiteSpace: 'pre-wrap',
                               stretch: 'horizontal'});
    if (!k[0]) { explainPanel.add(text); return; }
    explainPanel.add(hrow([
      ui.Label('', {backgroundColor: '#' + k[0], padding: '6px', margin: '4px 6px 2px 0',
                    border: '1px solid #444'}),
      text
    ]));
  });
  if (e.note) explainPanel.add(ui.Label(e.note, T));
  explainPanel.add(ui.Label(EXPLAIN_NEXT, {fontSize: '10px', color: '#555', margin: '4px 0 0 0',
                                           whiteSpace: 'pre-wrap'}));
}

// Plain-language sentence for a % change. Describes size only, never a cause.
//   plainSentence('this spot is', -79, 'the baseline')
//   -> 'this spot is about 79% darker at night than in the baseline. That is a very large fall.'
function fmtArea(km2) {
  return isNum(km2) && km2 < 1 ? 'under 1 km²' : fmtInt(km2) + ' km²';
}

function plainSentence(subject, pct, ref) {
  if (!isNum(pct)) return null;
  var size = Math.abs(pct);
  if (size < 10) return subject + ' about as bright at night as in ' + ref + '. Little overall change.';
  var kind = pct > 0 ? 'rise' : 'fall';
  var scale = size >= 60 ? 'a very large ' : size >= 30 ? 'a large ' : 'a modest ';
  if (pct >= 100) {
    var times = 1 + pct / 100;
    return subject + ' about ' + (times < 10 ? fmt(times, 1) : fmt(times, 0)) +
      ' times as bright at night as in ' + ref + '. That is a very large rise' +
      (times >= 5 ? ': most of this light is new.' : '.');
  }
  return subject + ' about ' + fmt(size, 0) + '% ' + (pct > 0 ? 'brighter' : 'darker') +
         ' at night than in ' + ref + '. That is ' + scale + kind + '.';
}

var VIEW_ITEMS = [
  {label: 'Change in brightness (%)', value: 'pct'},
  {label: 'Change in brightness (amount)', value: 'abs'},
  {label: 'Detected change areas', value: 'nodes'},
  {label: 'Brightness, later period', value: 'current'},
  {label: 'Brightness, earlier period', value: 'baseline'},
  {label: 'Both periods in one picture', value: 'composite'},
  {label: 'How much data we have', value: 'coverage'}
];
var VIEW_VALUES = VIEW_ITEMS.map(function(v) { return v.value; });
var viewSelect = ui.Select({items: VIEW_ITEMS, value: 'pct', style: {stretch: 'horizontal'}});
var opacityInfo = ui.Label('Overlay opacity: 85%', S_SMALL);
var opacitySlider = ui.Slider({min: 0.1, max: 1, value: 0.85, step: 0.05,
                               style: {stretch: 'horizontal'}});

// --- Change areas ---
var thresholdInfo = ui.Label('Change threshold: ±30%', S_SMALL);
var thresholdSlider = ui.Slider({min: 10, max: 90, value: 30, step: 5,
                                 style: {stretch: 'horizontal'}});
var minPxInfo = ui.Label('', S_SMALL);
var minPxSlider = ui.Slider({min: 1, max: 50, value: 5, step: 1,
                             style: {stretch: 'horizontal'}});
function minPxText(px) {
  return 'Minimum area size: ' + px + ' pixel' + (px > 1 ? 's' : '') +
         ' (about ' + (px * 0.215).toFixed(1) + ' km² at the equator)';
}
minPxInfo.setValue(minPxText(5));
var minAbsInfo = ui.Label('', S_SMALL);
var minAbsSlider = ui.Slider({min: 0, max: 5, value: 1, step: 0.25,
                              style: {stretch: 'horizontal'}});
function minAbsText(v) {
  return 'Minimum absolute change: ' + Number(v).toFixed(2) +
         ' nW/cm²/sr (stops noise near zero reading as a big % change)';
}
minAbsInfo.setValue(minAbsText(1));
var detectBtn = ui.Button({label: '📍 Detect change areas', style: {stretch: 'horizontal'}});

// --- Export ---
var exportBtn = ui.Button({label: '📤 Prepare downloads', style: {stretch: 'horizontal'}});
var driveBtn = ui.Button({label: '☁ Export to Google Drive (Code Editor only)',
                          style: {stretch: 'horizontal'}});
var exportPanel = ui.Panel({style: {shown: false, margin: '4px 0'}});

// --- Data quality ---
var minObsInfo = ui.Label('', S_SMALL);
var minObsSlider = ui.Slider({min: 1, max: 5, value: 1, step: 1, style: {stretch: 'horizontal'}});
function minObsText(v) {
  return 'Use a month only if it has ≥ ' + v + ' cloud-free observation' + (v > 1 ? 's' : '');
}
minObsInfo.setValue(minObsText(1));
var minValidInfo = ui.Label('', S_SMALL);
var minValidSlider = ui.Slider({min: 25, max: 100, value: DEFAULT_MATCH_PCT, step: 5,
                                style: {stretch: 'horizontal'}});
function minValidText(v) {
  return 'Each spot needs ' + v + '% of its months clear in BOTH periods, rounded up: ' +
    minValidMonths(12, v) + ' of 12, ' + minValidMonths(6, v) + ' of 6, ' +
    minValidMonths(3, v) + ' of 3' + (v < 50 ? '. Few months: results are noisier.' : '.');
}
minValidInfo.setValue(minValidText(DEFAULT_MATCH_PCT));
var datasetInfo = ui.Label('Dataset. Auto uses the stray-light corrected product at or above ' +
  AUTO_CORRECTED_LAT + '° latitude, where the standard product often loses summer months.', S_SMALL);
var datasetSelect = ui.Select({
  items: [
    {label: 'Auto (by latitude)', value: 'auto'},
    {label: 'Standard (VCMCFG, from Apr 2012)', value: 'standard'},
    {label: 'Stray-light corrected (VCMSLCFG, from Jan 2014)', value: 'corrected'}
  ],
  value: 'auto',
  style: {stretch: 'horizontal'}
});
var litInfo = ui.Label('', S_SMALL);
var litSlider = ui.Slider({min: 0.5, max: 5, value: 1, step: 0.5, style: {stretch: 'horizontal'}});
function litText(v) {
  return 'Lit footprint: above ' + Number(v).toFixed(1) + ' nW/cm²/sr in either window';
}
litInfo.setValue(litText(1));
var offshoreCheckbox = ui.Checkbox({
  label: 'Exclude offshore lights (LSIB land polygons)',
  value: false
});

// --- Guide and citation ---
var guidePanel = ui.Panel({
  widgets: [
    ui.Label('📖 How to read this', {fontWeight: 'bold', fontSize: '12px', margin: '0 0 4px 0'}),
    ui.Label('Brown: measured radiance fell. Teal: it rose. Purple: lit, but too few ' +
             'matched months to compare.', S_HINT),
    ui.Label('A radiance change is a measurement, not a cause. Falls can come from grid ' +
             'damage, fuel shortages, blackout policy, population loss, LED conversion or ' +
             'data gaps. Rises can come from construction, industry, fires, gas flares ' +
             'or camps. Check dated imagery, reporting and the coverage view before ' +
             'attributing a cause.', S_HINT),
    ui.Label('Limitations', {fontWeight: 'bold', fontSize: '11px', margin: '4px 0 2px 0'}),
    ui.Label('• Cloud: months without cloud-free observations are removed. See coverage.\n' +
             '• LED: white LEDs emit partly outside the sensor band and can read as a fall.\n' +
             '• Fires, gas flares and boats register as light.\n' +
             '• ~460 m pixels: district scale, not individual buildings.\n' +
             '• High latitudes: the standard product drops summer months. Auto mode uses the ' +
             'stray-light corrected product at or above ' + AUTO_CORRECTED_LAT + '°, which keeps ' +
             'them but can add twilight artefacts.', S_HINT)
  ],
  style: {backgroundColor: '#f0f0f0', padding: '6px', margin: '8px 0'}
});

var citationPanel = ui.Panel({
  widgets: [
    ui.Label('📝 How to cite', {fontWeight: 'bold', fontSize: '11px', margin: '0 0 4px 0'}),
    ui.Label('Tool: Strick, B. Dark Light Viewer v' + VERSION + '.', S_HINT),
    ui.Label(REPO_URL, {fontSize: '10px', color: '#1a73e8', margin: '0 0 4px 0'}).setUrl(REPO_URL),
    ui.Label('Data: NOAA/EOG VIIRS DNB Monthly Composites (VCMCFG or VCMSLCFG), via Google Earth Engine.',
             S_HINT),
    ui.Label('Use the methodology note under Technical results for exact dates and settings.', S_HINT)
  ],
  style: {backgroundColor: '#e8f0fe', padding: '6px', margin: '8px 0'}
});

// --- Right-hand dock: click chart and legend ---
var chartPanel = ui.Panel({style: {shown: false, width: '360px', padding: '4px', margin: '0 0 6px 0'}});
var legendPanel = ui.Panel({style: {shown: false, width: '270px', padding: '6px'}});
// The colour guide folds away so the map stays visible; it folds automatically
// while a pixel chart is open.
var legendCollapsed = false;
var rightDock = ui.Panel({widgets: [chartPanel, legendPanel],
                          style: {position: 'bottom-right', padding: '0', margin: '0'}});
rightMap.add(rightDock);

// ═══════════════════════════════════════
// 10) ASSEMBLE THE CONTROL PANEL
// ═══════════════════════════════════════
var controlPanel = ui.Panel({
  widgets: [
    headerPanel,
    archiveLabel,
    analyzeBtn,
    statusLabel,
    summaryPanel,
    explainBtn,
    explainPanel,
    section('Try an example', [locationSelect], false),
    section('Technical results', [resultsPanel], false),
    section('1. Where', [aoiModeSelect, aoiInfo, adminPanel, drawPanel, geojsonPanel], true),
    section('2. When', [periodSelect, customCheckbox, customPanel, windowsPreview], true),
    section('3. View', [viewSelect, opacityInfo, opacitySlider], true),
    section('4. Change areas', [thresholdInfo, thresholdSlider, minPxInfo, minPxSlider,
                                  minAbsInfo, minAbsSlider, detectBtn], true),
    section('5. Download', [exportBtn, driveBtn, exportPanel], false),
    section('Data quality (advanced)', [datasetInfo, datasetSelect, minObsInfo, minObsSlider,
                                        minValidInfo, minValidSlider,
                                        litInfo, litSlider, offshoreCheckbox], false),
    guidePanel,
    citationPanel
  ],
  style: {position: 'top-left', width: '345px', padding: '10px', maxHeight: '95%'}
});
leftMap.add(controlPanel);

// ═══════════════════════════════════════
// 11) AREA OF INTEREST
// ═══════════════════════════════════════
function currentPendingAoi() {
  var m = aoiModeSelect.getValue();
  return (m === 'admin' || m === 'geojson') ? state.aoiByKind[m] : null;
}

function refreshAoiInfo() {
  var m = aoiModeSelect.getValue();
  var p = currentPendingAoi();
  var txt;
  if (m === 'view') txt = 'The current map view, captured when you click ANALYSE.';
  else if (m === 'draw') txt = 'Your drawn shape(s).';
  else if (p) txt = 'Selected: ' + p.desc;
  else if (m === 'admin') txt = 'Nothing selected. Click "Pick area on map", then click the map.';
  else txt = 'Nothing selected. Paste GeoJSON below.';
  aoiInfo.setValue(txt);
}

function showPendingOutline() {
  var p = currentPendingAoi();
  leftMap.layers().reset(p ? [ui.Map.Layer(outlineImage(p.geometry, COL.pendingAoi), {},
                                           'Selected area')] : []);
  updateView(viewSelect.getValue());
}

function setPendingAoi(aoi) {
  state.aoiSeq += 1;
  aoi.id = state.aoiSeq;
  aoi.part = aoi.kind + ':' + aoi.id;
  state.aoiByKind[aoi.kind] = aoi;
  refreshAoiInfo();
  showPendingOutline();
  refreshStale('Area changed');
  return aoi;
}

function startDrawing() {
  leftMap.setControlVisibility({drawingToolsControl: true});
  drawingTools.setShown(true);
  drawingTools.setDrawModes(['polygon', 'rectangle']);
  drawingTools.setShape('polygon');
  drawingTools.draw();
  state.drawing = true;
}

function stopDrawing() {
  drawingTools.stop();
  drawingTools.setShown(false);
  leftMap.setControlVisibility({drawingToolsControl: false});
  state.drawing = false;
}

function drawnGeometry() {
  var layers = drawingTools.layers();
  var feats = [];
  for (var i = 0; i < layers.length(); i++) {
    var geoms = layers.get(i).geometries();
    for (var j = 0; j < geoms.length(); j++) feats.push(ee.Feature(geoms.get(j)));
  }
  if (!feats.length) return null;
  return {geometry: ee.FeatureCollection(feats).geometry(), parts: feats.length};
}

// Returns {aoi} or {error} for the selected mode.
function resolveAoi() {
  var mode = aoiModeSelect.getValue();
  if (mode === 'view') {
    var bbox = getViewBBox(leftMap);
    if (!bbox) return {error: 'Could not read the map bounds. Pan or zoom slightly and try again.'};
    var b = roundBbox(bbox, 4);
    return {aoi: {geometry: boundsToGeometry(b), desc: 'Map view rectangle ' + b.join(', '),
                  kind: 'bbox', bbox: b, part: 'view'}};
  }
  if (mode === 'draw') {
    var d = drawnGeometry();
    if (!d) return {error: 'Draw a polygon or rectangle first.'};
    return {aoi: {geometry: d.geometry, kind: 'drawn', part: 'draw:' + state.drawVersion,
                  desc: 'Drawn shape' + (d.parts > 1 ? 's (' + d.parts + ')' : '')}};
  }
  var p = currentPendingAoi();
  if (!p) {
    return {error: mode === 'admin'
      ? 'Pick an admin area first: click "Pick area on map", then click the map.'
      : 'Paste GeoJSON and click "Use this GeoJSON" first.'};
  }
  return {aoi: p};
}

function adminName(p, level) {
  var parts = [];
  if (level === '2' && p.ADM2_NAME) parts.push(p.ADM2_NAME);
  if ((level === '1' || level === '2') && p.ADM1_NAME) parts.push(p.ADM1_NAME);
  if (p.ADM0_NAME) parts.push(p.ADM0_NAME);
  return parts.length ? parts.join(', ') : 'unnamed area';
}

function resolveAdminAtPoint(level, lon, lat, cb) {
  var pt = ee.Geometry.Point([lon, lat]);
  var fc = GAUL[level].filterBounds(pt);
  var t = newToken('admin');
  ee.Dictionary({
    n: fc.size(),
    props: ee.Algorithms.If(fc.size().gt(0), ee.Feature(fc.first()).toDictionary(), null)
  }).evaluate(function(r, err) {
    if (!isCurrent('admin', t)) return;
    if (err) { cb(null, 'lookup failed: ' + errText(err)); return; }
    if (!r || !r.n) {
      cb(null, 'no GAUL level ' + level + ' area at ' + lat.toFixed(4) + ', ' +
               lon.toFixed(4) + ' (open sea or unmapped)');
      return;
    }
    var name = adminName(r.props || {}, level);
    cb({geometry: ee.Feature(fc.first()).geometry(), kind: 'admin',
        desc: 'FAO GAUL 2015 level ' + level + ': ' + name,
        admin: {level: level, lon: lon, lat: lat}});
  });
}

function resolveNamedAdmin(level, name, cb) {
  var fc = GAUL[level].filter(ee.Filter.eq('ADM' + level + '_NAME', name));
  var t = newToken('admin');
  fc.size().evaluate(function(n, err) {
    if (!isCurrent('admin', t)) return;
    if (err) { cb(null, 'lookup failed: ' + errText(err)); return; }
    if (!n) { cb(null, 'no GAUL level ' + level + ' area named "' + name + '"'); return; }
    cb({geometry: fc.geometry(), kind: 'admin',
        desc: 'FAO GAUL 2015 level ' + level + ': ' + name + (n > 1 ? ' (' + n + ' parts)' : ''),
        admin: {level: level, name: name}});
  });
}

function pickAdmin(coords) {
  state.awaitingAdminPick = false;
  var level = adminLevelSelect.getValue();
  setStatus('working', 'Looking up the admin area at ' + coords.lat.toFixed(4) + ', ' +
                       coords.lon.toFixed(4) + '...');
  resolveAdminAtPoint(level, coords.lon, coords.lat, function(aoi, err) {
    if (!aoi) { setStatus('insufficient', 'No area selected: ' + err + '.'); return; }
    setPendingAoi(aoi);
    setStatus('info', 'Selected ' + aoi.desc + '. Click ANALYSE.');
  });
}

aoiModeSelect.onChange(function(mode) {
  adminPanel.style().set('shown', mode === 'admin');
  drawPanel.style().set('shown', mode === 'draw');
  geojsonPanel.style().set('shown', mode === 'geojson');
  state.awaitingAdminPick = false;
  newToken('admin');
  if (mode === 'draw') startDrawing();
  else stopDrawing();
  refreshAoiInfo();
  showPendingOutline();
  refreshStale('Area mode changed');
});

function promptAdminPick() {
  setStatus('info', 'Click the map to choose an area (' +
                    adminLevelSelect.items().get(Number(adminLevelSelect.getValue())).label + ').');
}
adminPickBtn.onClick(function() {
  state.awaitingAdminPick = true;
  promptAdminPick();
});
// Changing the level keeps a pending pick active and updates the prompt.
adminLevelSelect.onChange(function() {
  newToken('admin');
  if (state.awaitingAdminPick) promptAdminPick();
});

drawBtn.onClick(startDrawing);
clearDrawBtn.onClick(function() {
  drawingTools.layers().reset();
  state.drawVersion += 1;
  refreshStale('Drawing cleared');
});
// A finished shape ends drawing mode, so later map clicks reach the chart.
drawingTools.onDraw(function() {
  state.drawVersion += 1;
  drawingTools.stop();
  state.drawing = false;
  refreshStale('Shape drawn');
});
drawingTools.onEdit(function() {
  state.drawVersion += 1;
  refreshStale('Shape edited');
});
drawingTools.onShapeChange(function(shape) { state.drawing = !!shape; });

useGeojsonBtn.onClick(function() {
  var parsed;
  try { parsed = parseGeoJsonAoi(geojsonBox.getValue()); }
  catch (e) { setStatus('failed', 'Invalid polygon geometry: ' + e.message); return; }
  if (parsed.error) { setStatus('insufficient', parsed.error); return; }
  setPendingAoi({geometry: parsed.geometry, kind: 'geojson',
                 desc: 'Pasted GeoJSON (' + parsed.summary + ')'});
  leftMap.centerObject(parsed.geometry);
  setStatus('info', 'GeoJSON area set. Click ANALYSE.');
});

// ═══════════════════════════════════════
// 12) COMPARISON CONTROLS
// ═══════════════════════════════════════
function selIdx(ySel, mSel) {
  var y = ySel.getValue();
  var m = mSel.getValue();
  if (!y || !m) return null;
  return ymIndex(Number(y), Number(m));
}

function getComparisonSpec() {
  if (customCheckbox.getValue()) {
    return {type: 'custom', baselineEnd: selIdx(baseYearSel, baseMonthSel),
            currentEnd: selIdx(curYearSel, curMonthSel),
            months: Number(lengthSel.getValue()), allowOverlap: overlapCheckbox.getValue()};
  }
  return {type: 'preset', key: periodSelect.getValue()};
}

function needsText(months) {
  var n = minValidMonths(months, minValidSlider.getValue());
  return 'Each spot needs ' + (n === months ? (months === 1 ? 'that month' : 'all ' + months +
    ' months') : n + ' of ' + months + ' months') + ' seen clearly in both periods.';
}

function updateWindowsPreview() {
  if (state.latest === null) { windowsPreview.setValue('Loading archive dates...'); return; }
  var w = buildWindows(getComparisonSpec(), state.latest);
  if (w.error) {
    windowsPreview.setValue('⚠️ ' + w.error);
    windowsPreview.style().set('color', '#c62828');
    return;
  }
  windowsPreview.setValue('Earlier period: ' + windowLabel(w.base) + '\nLater period:   ' +
    windowLabel(w.cur) + (w.overlap ? '\nThe windows share ' + w.overlap +
    ' months, which smooths the change.' : '') + (w.cur.months === 1
    ? '\nSingle months often have gaps from cloud or, at high latitudes, summer. ' +
      'Check the coverage view.' : '') + '\n' + needsText(w.cur.months));
  windowsPreview.style().set('color', '#333');
}

function setCustomWindows(baseEndIdx, curEndIdx, months, allowOverlap) {
  customCheckbox.setValue(true);
  overlapCheckbox.setValue(!!allowOverlap);
  baseYearSel.setValue(String(idxYear(baseEndIdx)));
  baseMonthSel.setValue(pad2(idxMonth(baseEndIdx)));
  curYearSel.setValue(String(idxYear(curEndIdx)));
  curMonthSel.setValue(pad2(idxMonth(curEndIdx)));
  lengthSel.setValue(String(months));
  updateWindowsPreview();
}

function populateYearSelects() {
  var years = [];
  for (var y = idxYear(state.latest); y >= 2012; y--) years.push(String(y));
  baseYearSel.items().reset(years);
  curYearSel.items().reset(years);
  var b = state.latest - 12;
  baseYearSel.setValue(String(idxYear(b)), false);
  baseMonthSel.setValue(pad2(idxMonth(b)), false);
  curYearSel.setValue(String(idxYear(state.latest)), false);
  curMonthSel.setValue(pad2(idxMonth(state.latest)), false);
}

function onComparisonChanged() {
  updateWindowsPreview();
  refreshStale('Comparison windows changed');
}
periodSelect.onChange(onComparisonChanged);
customCheckbox.onChange(function(on) {
  customPanel.style().set('shown', on);
  periodSelect.setDisabled(on);
  onComparisonChanged();
});
[baseYearSel, baseMonthSel, curYearSel, curMonthSel, lengthSel, overlapCheckbox].forEach(function(s) {
  s.onChange(onComparisonChanged);
});

// ═══════════════════════════════════════
// 13) STALE RESULTS AND INVALIDATION
// ═══════════════════════════════════════
function clearExportPanel() {
  exportPanel.clear();
  exportPanel.style().set('shown', false);
}

// Clears detected areas. Called whenever something they depend on changes.
function invalidateDetection(reason) {
  newToken('detect');
  newToken('export');
  var had = !!state.detection;
  state.detection = null;
  clearExportPanel();
  if (state.analysis) writeUrl();
  if (had) {
    if (viewSelect.getValue() === 'nodes') updateView('nodes');
    renderResults();
    if (reason) {
      setStatus('info', reason + ': detected areas cleared. Click "Detect change areas" to redo them.');
    }
  }
}

// A result is stale when the settings it was made with no longer match the
// controls on screen. Comparing the saved settings (rather than reacting to
// each control) also catches changes made while a request is running, and
// changing a setting back clears the warning.
function currentAoiPart() {
  var m = aoiModeSelect.getValue();
  if (m === 'view') return 'view';
  if (m === 'draw') return 'draw:' + state.drawVersion;
  var p = state.aoiByKind[m];
  return p ? p.part : m + ':none';
}

function settingsKey(settings, aoiPart) {
  var w = buildWindows(settings.comparison, state.latest);
  var wk = w.error ? 'invalid' : [w.base.start, w.base.end, w.cur.start, w.cur.end].join('-');
  return [wk, settings.dataset, settings.minObs, settings.minValidPct, settings.litThreshold,
          settings.excludeOffshore ? 1 : 0, aoiPart].join('|');
}

function uiMatches(a) {
  return settingsKey(readSettings(), currentAoiPart()) === a.key;
}

function refreshStale(reason) {
  var a = state.analysis;
  if (!a) return;
  var stale = !uiMatches(a);
  if (stale === state.analysisStale) return;
  state.analysisStale = stale;
  state.staleReason = stale ? reason : '';
  if (stale) {
    invalidateDetection(null);
    newToken('click');
    chartPanel.style().set('shown', false);
  }
  renderResults();
  updateLegend(viewSelect.getValue());
  if (stale) {
    setStatus('info', reason + '. The map still shows the previous result. Click ANALYSE to update.');
  } else {
    setStatus('info', 'The settings match the result on screen again.');
  }
}

thresholdSlider.onChange(function(v) {
  thresholdInfo.setValue('Change threshold: ±' + v + '%');
  invalidateDetection('Threshold changed');
});
minPxSlider.onChange(function(v) {
  minPxInfo.setValue(minPxText(v));
  invalidateDetection('Minimum area size changed');
});
minAbsSlider.onChange(function(v) {
  minAbsInfo.setValue(minAbsText(v));
  invalidateDetection('Minimum absolute change changed');
});
minObsSlider.onChange(function(v) { minObsInfo.setValue(minObsText(v)); refreshStale('Data quality settings changed'); });
minValidSlider.onChange(function(v) { minValidInfo.setValue(minValidText(v)); updateWindowsPreview(); refreshStale('Data quality settings changed'); });
datasetSelect.onChange(function() { refreshStale('Dataset changed'); });
litSlider.onChange(function(v) { litInfo.setValue(litText(v)); refreshStale('Lit threshold changed'); });
offshoreCheckbox.onChange(function() { refreshStale('Offshore setting changed'); });

opacitySlider.onChange(function(v) {
  opacityInfo.setValue('Overlay opacity: ' + Math.round(v * 100) + '%');
  state.opacityLayers.forEach(function(o) { o.layer.setOpacity(v * o.factor); });
});

// ═══════════════════════════════════════
// 14) ANALYSIS
// ═══════════════════════════════════════
function readSettings() {
  return {
    comparison: getComparisonSpec(),
    dataset: datasetSelect.getValue() || 'auto',
    minObs: minObsSlider.getValue(),
    minValidPct: minValidSlider.getValue(),
    litThreshold: litSlider.getValue(),
    excludeOffshore: offshoreCheckbox.getValue()
  };
}

// Re-run the analysis on screen with the current settings, on exactly the same
// area. Used by the one-click buttons in the summary.
function rerunSameArea() {
  var a = state.analysis;
  if (!a || !a.aoiInput) { analyzeNow(); return; }
  if ((a.aoiInput.part || 'view') !== currentAoiPart()) {
    setStatus('info', 'The area settings in "1. Where" have changed since this result. Click ' +
      'ANALYSE to run on the new area, or switch back to re-run the old one.');
    return;
  }
  runAnalysis(a.aoiInput, readSettings());
}

function analyzeNow(onDone) {
  if (state.latest === null) { setStatus('working', 'Still reading the archive dates...'); return; }
  var r = resolveAoi();
  if (!r.aoi) { setStatus('insufficient', r.error); return; }
  runAnalysis(r.aoi, readSettings(), onDone);
}
analyzeBtn.onClick(function() { analyzeNow(); });

function analysisCautions(a) {
  var warnings = [];
  if (!a.pairing.calendar) {
    warnings.push('The two periods cover different months of the year; seasons may contribute.');
  }
  if (a.datasetFallback) {
    warnings.push('Summer months are missing at this latitude in this dataset.');
  }
  if (a.windows.overlap) warnings.push('The two periods overlap, which hides short changes.');
  return warnings.join(' ');
}

// Advice when data are missing, tailored to the likely reason.
function gapAdvice(a) {
  var lat = Math.abs(a.centreLat);
  var preCorr = a.windows.base.start < DATASETS.corrected.first;
  if (a.dataset.code === 'VCMCFG' && isNum(lat) && lat >= AUTO_CORRECTED_LAT && preCorr) {
    return 'The clearer dataset only starts in 2014. Choose an earlier period that starts in ' +
           '2014 or later (2. When).';
  }
  if (a.dataset.code === 'VCMCFG' && !preCorr && isNum(lat) && lat >= AUTO_CORRECTED_LAT) {
    return 'Try the stray-light corrected dataset under Data quality (advanced), or a ' +
           '12-month comparison.';
  }
  if (a.dataset.code === 'VCMCFG' && isNum(lat) && lat < AUTO_CORRECTED_LAT) {
    return 'Cloudy seasons hide the lights here. Try a 12-month comparison or a drier season.';
  }
  if (isNum(lat) && lat >= 60 && a.windows.cur.months < 12) {
    return 'Far from the equator, summer nights are too short to see lights. Try a 12-month ' +
           'comparison or winter months.';
  }
  if (a.windows.cur.months < 12) return 'Try a 12-month comparison.';
  return 'Try a different period or a larger area, and check "How much data we have" in the view list.';
}

// Returns {kind, message, notes, headline}. message is the short status line;
// notes are plain cautions for the summary; headline is false when no figure
// should be shown.
function judgeSummary(a, s) {
  var fp = Math.round(s.n_footprint || 0);
  var ok = Math.round(s.n_analysable || 0);
  var shares = dataShares(s);
  var notes = [];
  if (s.n_images_cur < a.windows.cur.months || s.n_images_base < a.windows.base.months) {
    return {kind: 'insufficient', headline: false, notes: notes, message: 'The satellite archive ' +
      'is missing some months (later period ' + s.n_images_cur + ' of ' + a.windows.cur.months +
      ', earlier period ' + s.n_images_base + ' of ' + a.windows.base.months + '). Choose ' +
      'different dates.'};
  }
  if (!fp) {
    if (shares.both < 50) {
      return {kind: 'insufficient', headline: false, notes: notes, message: 'The satellite could ' +
        'not see most of this area clearly in one of the periods (cloud or short summer nights). ' +
        'This is missing data, not darkness. ' + gapAdvice(a)};
    }
    return {kind: 'insufficient', headline: false, notes: notes,
            message: 'No lights bright enough to measure here. Try a town or city.'};
  }
  if (!ok) {
    return {kind: 'insufficient', headline: false, notes: notes, message: 'There are not enough ' +
      'clear-sky months to compare this area fairly. That is missing data, not darkness. ' +
      gapAdvice(a)};
  }
  if (solChange(s) === null) {
    var newLight = isNum(s.sum_cur) && s.sum_cur > 0;
    return {kind: 'insufficient', headline: false, notes: notes, message: newLight
      ? 'There was almost no light here in ' + windowSpan(a.windows.base) + ', and there is now. ' +
        'A percentage cannot describe light appearing from almost nothing. Look at the map and ' +
        'the "Brightness, later period" view.'
      : 'There was no measurable light here in either period, so there is no change to report.'};
  }
  if (ok < MIN_COMPARED_PX) {
    return {kind: 'insufficient', headline: false, notes: notes, message: 'Too few lit spots to ' +
      'judge (' + ok + '). A handful of lights, such as a passing ship, can swing the figure. ' +
      'Try a larger area or a town.'};
  }
  var cov = ok / fp * 100;
  var sol = solChange(s);
  if (cov < 50) notes.push('Only ' + fmt(cov, 0) + '% of lit spots could be compared, so this ' +
    'may not represent the whole area.');
  else if (cov < 80) notes.push('About ' + fmt(100 - cov, 0) + '% of lit spots could not be ' +
    'compared (not enough clear-sky months), so treat the figure as partial.');
  if (isNum(sol) && Math.abs(sol) < 10 && ((isNum(s.p10) && s.p10 <= -30) ||
      (isNum(s.p90) && s.p90 >= 30))) {
    notes.push('Different parts of this area moved in opposite directions: some much darker, ' +
      'some much brighter. The total hides that. Look at the map, not just this figure.');
  }
  if (a.windows.cur.months === 1) notes.push('This compares single months, which swing with ' +
    'weather and short events. A 12-month comparison is steadier.');
  if (shares.none >= 25) notes.push(fmt(shares.none, 0) + '% of the area had no clear view in ' +
    'one of the periods, so lights there are not counted.');
  var seaShare = s.n_lit_all ? (s.n_lit_sea || 0) / s.n_lit_all * 100 : 0;
  if (!a.settings.excludeOffshore && seaShare >= SEA_SHARE_WARN) {
    notes.push('About ' + fmt(seaShare, 0) + '% of the lit spots are at sea, usually boats or ' +
      'platforms. Their lights come and go.');
    a.seaWarning = true;
  } else {
    a.seaWarning = false;
  }
  if (isNum(sol) && sol >= 100) notes.push('Very large rises can also come from fires or gas ' +
    'flares. Check satellite imagery before reading this as growth.');
  if (!a.pairing.calendar) notes.push('The two periods cover different months of the year, ' +
    'so seasons may explain part of the change.');
  if (a.windows.overlap) notes.push('The two periods overlap, which hides short changes.');
  if (a.datasetFallback) notes.push('This dataset misses summer months this far from the ' +
    'equator before 2014.');
  if (isStricterThanDefault(a)) notes.push('A strict coverage setting is in use.');
  var kind = notes.length ? 'insufficient' : 'ok';
  a.basis = 'Based on ' + fmtInt(ok) + ' of ' + fmtInt(fp) + ' lit spots.';
  var message = cov < 50 ? 'Done, but only ' + fmt(cov, 0) + '% of the lit area had enough data. ' +
    'Read the summary below.' : notes.length ? 'Done, with cautions. Read the summary below.' :
    'Done. Read the summary below.';
  return {kind: kind, headline: true, notes: notes, message: message};
}

// Share (%) of the area's pixels with data in both windows, and with no
// usable data (unlit where seen, but a window has no observation at all).
function dataShares(s) {
  var all = s.n_all || 0;
  return {
    both: all ? (s.n_data_both || 0) / all * 100 : 0,
    none: all ? (s.n_no_data || 0) / all * 100 : 0
  };
}

function runAnalysis(aoi, settings, onDone) {
  var win = buildWindows(settings.comparison, state.latest);
  if (win.error) { setStatus('insufficient', win.error); return; }
  var key = settingsKey(settings, aoi.part || 'view');
  state.attempt = (state.attempt || 0) + 1;
  var attempt = state.attempt;

  // The result on screen is replaced only once the new area passes its
  // checks, so a refused run leaves the previous result (and its detected
  // areas) intact.
  var ct = newToken('areacheck');
  state.checking = true;
  setStatus('working', 'Checking the area...');
  var request = {
    area: aoi.geometry.area(1000),
    bounds: aoi.geometry.bounds(1000).coordinates()
  };
  if (aoi.kind === 'drawn' || aoi.kind === 'geojson') request.geom = aoi.geometry;

  ee.Dictionary(request).evaluate(function(info, err) {
    if (!isCurrent('areacheck', ct)) return;
    state.checking = false;
    if (err || !info) {
      setStatus('failed', 'Could not read the area: ' + errText(err) + '.');
      return;
    }
    var km2 = info.area / 1e6;
    if (!(km2 > 0)) { setStatus('insufficient', 'The area has zero size. Choose or draw a polygon.'); return; }
    if (km2 > MAX_AOI_KM2) {
      setStatus('insufficient', 'The area is ' + fmtInt(km2) + ' km², above the ' +
        fmtInt(MAX_AOI_KM2) + ' km² limit. Zoom in or choose a smaller area.');
      return;
    }

    var bb = aoi.bbox || bboxFromRing(info.bounds);
    var dsr = resolveDataset(settings.dataset, win, bb ? (bb[1] + bb[3]) / 2 : null);
    if (dsr.error) { setStatus('insufficient', dsr.error); return; }

    var t = newToken('analysis');
    newToken('click');
    chartPanel.clear();
    chartPanel.style().set('shown', false);
    invalidateDetection(null);
    var a = computeAnalysis(aoi.geometry, win, settings, dsr.ds);
    a.datasetNote = dsr.note;
    a.attempt = attempt;
    a.aoiInput = aoi;   // the exact area, so one-click re-runs never switch to the map view
    a.centreLat = bb ? (bb[1] + bb[3]) / 2 : null;
    a.datasetFallback = !!dsr.fallback;
    a.token = t;
    a.key = key;
    a.aoi = {desc: aoi.desc, kind: aoi.kind, bbox: aoi.bbox || bboxFromRing(info.bounds),
             km2: km2, admin: aoi.admin || null, geometry: aoi.geometry,
             approx: !!aoi.approx, linkGeo: null, linkNote: ''};
    if (aoi.kind === 'drawn' || aoi.kind === 'geojson') {
      a.aoi.linkGeo = compactGeoJson(info.geom);
      if (!a.aoi.linkGeo) {
        a.aoi.linkNote = 'This shape is too detailed to store in a link. Download the analysed ' +
          'area and share it separately. Opening this link will require the exact GeoJSON.';
      }
    }
    a.windows = win;
    a.settings = settings;
    a.generatedUtc = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    a.summaryResult = undefined;   // undefined = pending, null = failed
    state.analysis = a;
    // Settings may have changed while the area was being checked.
    state.analysisStale = !uiMatches(a);
    state.staleReason = state.analysisStale ? 'Settings changed while this analysis was running' : '';

    writeUrl();
    updateView(viewSelect.getValue());
    renderResults();
    setStatus('working', 'Measuring ' + fmtArea(km2) +
      (km2 > WARN_AOI_KM2 ? ' (large area, this may be slow)' : '') + '...');

    a.summary.evaluate(function(s, err2) {
      if (!isCurrent('analysis', t)) return;
      if (err2 || !s) {
        a.summaryResult = null;
        renderResults();
        if (!state.checking && state.attempt === a.attempt) {
          setStatus('failed', 'The summary failed: ' + errText(err2) +
            '. The map layers may still draw. Try a smaller area.');
        }
        return;
      }
      a.summaryResult = s;
      a.verdict = judgeSummary(a, s);
      renderSummary();
      renderResults();
      updateLegend(viewSelect.getValue());
      // A later run that was refused keeps its message on screen.
      if (!state.checking && state.attempt === a.attempt) {
        setStatus(a.verdict.kind, a.verdict.message + (state.analysisStale
          ? ' Settings have changed since: click ANALYSE to update.' : ''));
      }
      if (onDone && !state.analysisStale && !state.checking) onDone(a);
    });
  });
}

// ═══════════════════════════════════════
// 15) MAP LAYERS AND LEGEND
// ═══════════════════════════════════════
function updateView(mode) {
  var a = state.analysis;
  var d = state.detection;
  var op = opacitySlider.getValue();
  var layers = [];
  state.opacityLayers = [];

  function addImg(img, vis, name, factor) {
    var f = factor || 1;
    var lyr = ui.Map.Layer(img, vis, name, true, op * f);
    layers.push(lyr);
    state.opacityLayers.push({layer: lyr, factor: f});
  }
  function addInsufficient() {
    addImg(a.insufficient.clip(a.region), {palette: [COL.insufficient]},
           'Lit, but too few clear-sky months to compare', 0.7);
  }
  function addNoData() {
    addImg(a.noData.selfMask().clip(a.region), {palette: [COL.noData]},
           'No clear view in a period (unknown, not dark)', 0.6);
  }
  function addPct() {
    addImg(a.pct.clip(a.region), {min: -100, max: 100, palette: PAL.change},
           'Change in brightness (%)');
  }

  if (a) {
    var r = a.region;
    if (mode === 'pct') {
      addPct();
      addInsufficient();
      addNoData();
    } else if (mode === 'abs') {
      addImg(a.abs.clip(r), {min: -20, max: 20, palette: PAL.change},
             'Change in brightness (amount)');
      addInsufficient();
      addNoData();
    } else if (mode === 'current') {
      addImg(a.cur.clip(r), {min: 0, max: 60, palette: PAL.radiance},
             'Brightness, later period: ' + windowLabel(a.windows.cur));
    } else if (mode === 'baseline') {
      addImg(a.base.clip(r), {min: 0, max: 60, palette: PAL.radiance},
             'Brightness, earlier period: ' + windowLabel(a.windows.base));
    } else if (mode === 'composite') {
      addImg(ee.Image.cat([a.base.rename('R_baseline'), a.cur.rename('G_comparison'),
                           a.cur.rename('B_comparison')]).clip(r),
             {bands: ['R_baseline', 'G_comparison', 'B_comparison'], min: 0, max: 40},
             'Both periods: red = earlier, blue-green = later');
    } else if (mode === 'coverage') {
      addImg(a.nMatched.clip(r),
             {min: 0, max: a.windows.cur.months, palette: PAL.coverage},
             'Clear-sky months in both periods');
    } else if (mode === 'nodes') {
      if (d && d.analysisToken === a.token) {
        addImg(d.classImage.clip(r), {min: 1, max: 2, palette: [COL.decrease, COL.increase]},
               'All spots that changed by ' + d.settings.threshold + '% or more (brown fell, teal rose)', 0.6);
        layers.push(ui.Map.Layer(d.polygons.style({styleProperty: 'style_poly'}), {},
                                 'Changed areas (outlines)', true));
        layers.push(ui.Map.Layer(d.points.style({styleProperty: 'style_point'}), {},
                                 'Changed areas (centre points)', true));
      } else {
        addPct();
      }
    }
    layers.push(ui.Map.Layer(outlineImage(r, COL.aoi), {}, 'Analysed area', true));
  }

  var p = currentPendingAoi();
  if (p && (!a || p.geometry !== a.aoi.geometry)) {
    layers.push(ui.Map.Layer(outlineImage(p.geometry, COL.pendingAoi), {},
                             'Selected area (not analysed yet)', true));
  }
  rightMap.layers().reset(layers);
  updateLegend(mode);
}

viewSelect.onChange(function(v) {
  updateView(v);

  try { ui.url.set('view', v); } catch (e) { /* links are optional */ }
});

function colorBar(palette, labels) {
  var bar = ui.Thumbnail({
    image: ee.Image.pixelLonLat().select(0),
    params: {bbox: [0, 0, 1, 0.1], dimensions: '200x12', format: 'png',
             min: 0, max: 1, palette: palette},
    style: {stretch: 'horizontal', margin: '2px 0', maxHeight: '14px'}
  });
  var aligns = ['left', 'center', 'right'];
  var row = hrow(labels.map(function(l, i) {
    return ui.Label(l, {fontSize: '10px', margin: '0', stretch: 'horizontal',
                        textAlign: aligns[Math.min(i, 2)]});
  }));
  return ui.Panel([bar, row]);
}

function swatch(color, text) {
  return hrow([
    ui.Label('', {backgroundColor: '#' + color, padding: '6px', margin: '2px 6px 2px 0',
                  border: '1px solid #444'}),
    ui.Label(text, {fontSize: '10px', margin: '3px 0', whiteSpace: 'pre-wrap', maxWidth: '250px'})
  ]);
}

function captionText(a) {
  var lines = [
    'Dark Light Viewer v' + VERSION + ' | VIIRS DNB monthly (' + a.dataset.code + ')',
    'Earlier period: ' + windowLabel(a.windows.base),
    'Later period:   ' + windowLabel(a.windows.cur),
    '≥' + a.settings.minObs + ' cloud-free obs/month, ≥' + a.minValid + ' of ' +
      a.windows.cur.months + ' months matched, lit > ' +
      Number(a.settings.litThreshold).toFixed(1) + ' nW',
    'Area: ' + shorten(a.aoi.desc, 58)
  ];
  if (!a.pairing.calendar) lines.push('⚠️ Different calendar months, paired in order');
  var v = a.verdict;
  var firstSentence = function(t) { return t.split('. ')[0].replace(/\.$/, '') + '.'; };
  if (v && !v.headline) lines.push('⚠️ No overall figure: ' + firstSentence(v.message));
  else if (v && v.notes && v.notes.length) {
    v.notes.forEach(function(n) { lines.push('⚠️ ' + firstSentence(n)); });
  }
  if (a.basis) lines.push(a.basis);
  if (state.analysisStale) lines.push('⚠️ Settings changed since this result');
  return lines.join('\n');
}

function updateLegend(mode) {
  if (explainOpen) renderExplain(mode);
  legendPanel.clear();
  var a = state.analysis;
  if (!a) { legendPanel.style().set('shown', false); return; }
  legendPanel.style().set('shown', true);
  var titles = {
    pct: 'Change in night-time brightness (%)',
    abs: 'Change in night-time brightness (amount)',
    current: 'Night-time brightness, later period',
    baseline: 'Night-time brightness, earlier period',
    composite: 'Both periods in one picture',
    coverage: 'How much data we have (clear-sky months)',
    nodes: 'Detected change areas'
  };
  var foldBtn = ui.Button({label: legendCollapsed ? '＋ Show guide' : '－ Hide',
                          style: {margin: '0', padding: '0', fontSize: '10px'}});
  foldBtn.onClick(function() { legendCollapsed = !legendCollapsed; updateLegend(viewSelect.getValue()); });
  legendPanel.add(hrow([ui.Label(titles[mode] || '', {fontWeight: 'bold', fontSize: '12px',
                                                      margin: '4px 0', stretch: 'horizontal'}),
                        foldBtn]));
  var changeKeys = function() {
    legendPanel.add(swatch('bf812d', 'Darker at night. Often goes with power cuts, damage, people ' +
                                     'leaving or closures; also LED switch-overs.'));
    legendPanel.add(swatch('35978f', 'Brighter at night. Often goes with building, industry or more ' +
                                     'people; also fires and gas flares.'));
    legendPanel.add(swatch('f5f5f5', 'Little change.'));
    legendPanel.add(swatch(COL.insufficient, 'Lit, but too few months to compare: missing data, not darkness.'));
    legendPanel.add(swatch(COL.noData, 'No clear view in a period: unknown, not dark.'));
  };
  if (mode === 'pct') {
    legendPanel.add(colorBar(PAL.change, ['-100% or less', '0', '+100% or more']));
    changeKeys();
  } else if (mode === 'abs') {
    legendPanel.add(colorBar(PAL.change, ['-20', '0', '+20']));
    changeKeys();
  } else if (mode === 'current' || mode === 'baseline') {
    legendPanel.add(colorBar(PAL.radiance, ['0', '30', '60+']));
    legendPanel.add(swatch('fcffa4', 'Bright: city centres, main roads, ports, industry.'));
    legendPanel.add(swatch('cf4446', 'Moderately lit: suburbs, towns, smaller roads.'));
    legendPanel.add(swatch('000004', 'Dark or unlit.'));
  } else if (mode === 'coverage') {
    var n = a.windows.cur.months;
    legendPanel.add(colorBar(PAL.coverage, ['0', n >= 3 ? String(Math.round(n / 2)) : '', String(n)]));
    legendPanel.add(swatch('fde725', 'Full data in both periods: the most reliable results.'));
    legendPanel.add(swatch('440154', 'Few or no months seen clearly: missing data, not darkness.'));
    legendPanel.add(ui.Label('Pixels below ' + a.minValid + ' matched months are left out of ' +
                             'the change figures.',
                             {fontSize: '10px', margin: '2px 0', whiteSpace: 'pre-wrap'}));
  } else if (mode === 'composite') {
    legendPanel.add(swatch('ff0000', 'Red: brighter in the baseline. Light lost.'));
    legendPanel.add(swatch('00ffff', 'Cyan: brighter now. Light gained.'));
    legendPanel.add(swatch('ffffff', 'White: bright in both. Stable.'));
    legendPanel.add(swatch('000000', 'Black: dark in both.'));
  } else if (mode === 'nodes') {
    var d = state.detection;
    if (d && d.analysisToken === a.token) {
      var thr = d.settings.threshold;
      CHANGE_BANDS.forEach(function(b) {
        if (b.key.indexOf('<50%') >= 0 && thr >= 50) return;
        legendPanel.add(swatch(b.color, bandLabel(b.key, thr)));
      });
      legendPanel.add(ui.Label('Each pixel also changed by at least ' +
        Number(d.settings.minAbs).toFixed(2) + ' nW/cm²/sr.', {fontSize: '10px', margin: '2px 0'}));
    } else {
      legendPanel.add(colorBar(PAL.change, ['-100%', '0', '+100%']));
      legendPanel.add(ui.Label('No change areas yet. Click "Detect change areas" (section 4).',
                               {fontSize: '10px', margin: '2px 0'}));
    }
  }
  if (mode === 'pct') {
    legendPanel.add(ui.Label('Very dim places can show big percentages from tiny changes. ' +
      'Check the amount view too.', S_HINT));
  }
  if (mode === 'nodes') {
    legendPanel.add(ui.Label('Brown areas: light fell. Teal: light rose.',
                             {fontSize: '10px', color: '#555', margin: '4px 0 0 0'}));
  }
  legendPanel.add(ui.Label('A measurement, not a cause. Full guide: ❓ What does this mean? ' +
                           'at the top of the panel.',
                           {fontSize: '10px', color: '#555', margin: '4px 0 0 0', whiteSpace: 'pre-wrap'}));
  legendPanel.add(ui.Label(captionText(a), {fontSize: '10px', color: '#333',
                                            whiteSpace: 'pre-wrap', margin: '6px 0 0 0'}));
  if (legendCollapsed) {
    legendPanel.widgets().forEach(function(w, i) { if (i >= 2) w.style().set('shown', false); });
  }
}

// ═══════════════════════════════════════
// 16) RESULTS PANEL AND METHODOLOGY NOTE
// ═══════════════════════════════════════
function methodologyNote(a) {
  var s = a.summaryResult;
  var st = a.settings;
  var parts = [
    'Method: Dark Light Viewer v' + VERSION + ' (' + REPO_URL + ') in Google Earth Engine.',
    'Data: NOAA/EOG VIIRS Day/Night Band monthly composites, ' + a.dataset.code + ' (' +
      a.dataset.id + '), native ~464 m grid' + (a.dataset.code === 'VCMSLCFG'
        ? '; stray-light corrected, which can add twilight artefacts' : '') +
      ' (dataset ' + a.datasetNote + ').',
    'Comparison: mean radiance for ' + windowText(a.windows.cur) + ' against ' +
      windowText(a.windows.base) + '.',
    'Quality: monthly values with fewer than ' + st.minObs + ' cloud-free observation' +
      (st.minObs > 1 ? 's' : '') + ' were removed. Months were paired ' +
      (a.pairing.calendar ? 'by calendar month' : 'in order') + ' between the windows and ' +
      'used only where valid in both; each pixel needed at least ' + a.minValid + ' of ' +
      a.windows.cur.months + ' matched months.',
    'Footprint: pixels above ' + Number(st.litThreshold).toFixed(1) +
      ' nW/cm²/sr in either window' + (st.excludeOffshore ? ', on land (LSIB 2017 simplified)' : '') + '.',
    'Area: ' + a.aoi.desc + ', ' + fmtArea(a.aoi.km2) + '.'
  ];
  if (s) {
    var fp = Math.round(s.n_footprint || 0);
    var ok = Math.round(s.n_analysable || 0);
    parts.push('Result: the sum of pixel radiances across the footprint changed by ' +
      (solChange(s) === null ? 'n/a' : fmtSigned(solChange(s), 1) + '%') + ' (' +
      fmtInt(ok) + ' pixels; ' + (fp ? fmt(ok / fp * 100, 0) : '0') +
      '% of lit pixels had enough data).');
    parts.push('Data coverage: ' + fmt(dataShares(s).both, 0) + '% of the area was observed ' +
      'at least once in both windows; lit pixels averaged ' + fmt(s.mean_matched, 1) + ' of ' +
      a.windows.cur.months + ' matched months.');
  }
  var d = state.detection;
  if (d && d.analysisToken === a.token) {
    parts.push('Change areas: ' + d.count + ' clusters of pixels that changed by at least ' +
      d.settings.threshold + '% and ' + Number(d.settings.minAbs).toFixed(2) +
      ' nW/cm²/sr, minimum ' + d.settings.minPx + ' pixels.');
  }
  parts.push('Radiance sums are an index on the native grid, not emitted power. ' +
    'Pixel change uses max(baseline, 0.5) as its denominator.');
  if (!a.pairing.calendar) {
    parts.push('These windows cover different calendar months; seasonal effects may contribute.');
  }
  parts.push('Generated ' + a.generatedUtc + '.');
  return parts.join(' ');
}

function isStricterThanDefault(a) {
  return a.minValid > minValidMonths(a.windows.cur.months, DEFAULT_MATCH_PCT);
}

function strictSettingNote(a) {
  if (!isStricterThanDefault(a)) return '';
  var months = a.windows.cur.months;
  return '⚠️ Strict coverage setting: each pixel needs ' + a.minValid + ' of ' + months +
    ' matched months (default ' + minValidMonths(months, DEFAULT_MATCH_PCT) + '). It may have ' +
    'come from a shared link. Change it under Data quality (advanced).';
}

function renderSummary() {
  var a = state.analysis;
  summaryPanel.clear();
  if (!a) { summaryPanel.style().set('shown', false); return; }
  var S = function(text, extra) {
    var st = {fontSize: '11px', margin: '2px 0', whiteSpace: 'pre-wrap'};
    for (var k in (extra || {})) st[k] = extra[k];
    summaryPanel.add(ui.Label(text, st));
  };
  var s = a.summaryResult;
  var v = a.verdict;
  var shown = false;
  if (s && v && v.headline) {
    var plain = plainSentence('taken together, the lit parts of this area are', solChange(s),
                              windowSpan(a.windows.base));
    if (plain) {
      S('In plain terms: ' + plain + ' This measures light, not its cause.',
        {fontSize: '12px', color: '#3e2723'});
      if (a.basis) S(a.basis, {fontSize: '10px', color: '#666'});
      shown = true;
    }
    v.notes.forEach(function(n) { S('⚠️ ' + n, {color: '#8a4b00'}); });
    if (a.seaWarning) {
      var seaBtn = ui.Button({label: '🌊 Leave out lights at sea and re-analyse',
                              style: {stretch: 'horizontal', margin: '2px 0'}});
      seaBtn.onClick(function() { offshoreCheckbox.setValue(true); rerunSameArea(); });
      summaryPanel.add(seaBtn);
    }
  } else if (s && v && !v.headline) {
    S(v.message, {fontSize: '12px', color: '#8a4b00'});
    shown = true;
  }
  var strict = strictSettingNote(a);
  if (strict) {
    S(strict, {color: '#c62828'});
    var resetBtn = ui.Button({label: '↺ Use the default (' + DEFAULT_MATCH_PCT + '%) and re-analyse',
                              style: {stretch: 'horizontal', margin: '2px 0'}});
    resetBtn.onClick(function() {
      minValidSlider.setValue(DEFAULT_MATCH_PCT);
      rerunSameArea();
    });
    summaryPanel.add(resetBtn);
    shown = true;
  }
  if (shown) S('Numbers, dates and method: Technical results, below.', {fontSize: '10px', color: '#666'});
  summaryPanel.style().set('shown', shown);
}

function renderResults() {
  var a = state.analysis;
  renderSummary();
  resultsPanel.clear();
  if (!a) { resultsPanel.style().set('shown', false); return; }
  resultsPanel.style().set('shown', true);
  var L = function(text, style) {
    resultsPanel.add(ui.Label(text, style || {fontSize: '11px', margin: '1px 0', whiteSpace: 'pre-wrap'}));
  };
  L('📊 Results', {fontWeight: 'bold', fontSize: '12px', margin: '0 0 4px 0'});
  if (strictSettingNote(a)) L(strictSettingNote(a), {fontSize: '11px', color: '#c62828',
                                                     margin: '0 0 4px 0', whiteSpace: 'pre-wrap'});
  if (state.analysisStale) {
    L('⚠️ Settings changed since this result (' + state.staleReason + '). Click ANALYSE to update.',
      {fontSize: '11px', color: '#c62828', margin: '0 0 4px 0', whiteSpace: 'pre-wrap'});
  }
  L('Area: ' + a.aoi.desc + ' (' + fmtArea(a.aoi.km2) + ')');
  if (a.aoi.linkNote) {
    L('🔗 ' + a.aoi.linkNote, {fontSize: '10px', color: '#8a6d00', margin: '1px 0', whiteSpace: 'pre-wrap'});
  }
  L('Earlier period: ' + windowLabel(a.windows.base));
  L('Later period:   ' + windowLabel(a.windows.cur));
  L('Dataset: ' + a.dataset.label + ' (' + a.datasetNote + ')');

  var s = a.summaryResult;
  if (s === undefined) {
    L('Computing the summary...');
  } else if (s === null) {
    L('The summary failed. See the status message above.', {fontSize: '11px', color: '#c62828'});
  } else {
    var fp = Math.round(s.n_footprint || 0);
    var ok = Math.round(s.n_analysable || 0);
    L('Radiance-sum change: ' + (solChange(s) === null ? 'n/a' : fmtSigned(solChange(s), 1) + '%') +
      ' (same lit pixels in both windows)', {fontSize: '12px', fontWeight: 'bold', margin: '4px 0 2px 0'});
    L('Lit pixels: ' + fmtInt(fp) + '. With enough data: ' + fmtInt(ok) +
      (fp ? ' (' + fmt(ok / fp * 100, 0) + '%)' : '') + '.');
    var pc = function(v) { return isNum(v) && v >= PCT_CAP - 0.5 ? '≥ +' + PCT_CAP : fmtSigned(v, 0); };
    L('Pixel change, 10th / 50th / 90th percentile: ' + pc(s.p10) + ' / ' +
      pc(s.p50) + ' / ' + pc(s.p90) + '%');
    L('Average matched months on lit pixels: ' + fmt(s.mean_matched, 1) + ' of ' +
      a.windows.cur.months + ' (needs ' + a.minValid + '; valid months: baseline ' +
      fmt(s.mean_valid_base, 1) + ', comparison ' + fmt(s.mean_valid_cur, 1) + ').');
    var sh = dataShares(s);
    L('Area observed at least once in both windows: ' + fmt(sh.both, 0) + '%' +
      (sh.none >= 5 ? ' (' + fmt(sh.none, 0) + '% unknown: no data in a window)' : '') + '.');
  }

  var d = state.detection;
  if (d && d.analysisToken === a.token) {
    L('Change areas: ' + d.count + ' at ±' + d.settings.threshold + '% and ≥ ' +
      Number(d.settings.minAbs).toFixed(2) + ' nW, minimum ' + d.settings.minPx + ' px (' +
      fmt(d.areaKm2, 1) + ' km² in total).',
      {fontSize: '11px', fontWeight: 'bold', margin: '4px 0 1px 0', whiteSpace: 'pre-wrap'});
    CHANGE_BANDS.map(function(b) { return b.key; }).concat(['no data']).forEach(function(k) {
      var n = d.bands && d.bands[k];
      if (n) L('   ' + bandLabel(k, d.settings.threshold) + ': ' + n);
    });
  }

  if (s) {
    var cautions = analysisCautions(a);
    if (cautions) L('⚠️ ' + cautions, S_HINT);
    L('Methodology note (select and copy):', {fontSize: '11px', fontWeight: 'bold', margin: '6px 0 1px 0'});
    L(methodologyNote(a), {fontSize: '10px', color: '#333', margin: '0', whiteSpace: 'pre-wrap',
                           backgroundColor: '#ffffff', padding: '4px'});
  }
}

// ═══════════════════════════════════════
// 17) CHANGE AREA DETECTION
// ═══════════════════════════════════════
function detectionProblem(a) {
  if (state.checking) return 'Wait for the new area check to finish before detecting change.';
  if (a.summaryResult === undefined) return 'Wait for the analysis summary to finish.';
  if (a.summaryResult === null) return 'The analysis failed. Run ANALYSE successfully before detecting change.';
  var s = a.summaryResult;
  if (!isNum(s.n_analysable) || s.n_analysable <= 0) {
    return 'No comparable lit pixels. This is insufficient data or no lit footprint, not zero change.';
  }
  if (s.n_images_cur !== a.windows.cur.months || s.n_images_base !== a.windows.base.months) {
    return 'The archive window is incomplete. Choose fully available windows before detecting change.';
  }
  return null;
}

function detectNow(onDone) {
  var a = state.analysis;
  if (!a) { setStatus('insufficient', 'Run ANALYSE first.'); return; }
  if (state.analysisStale || !uiMatches(a)) {
    setStatus('insufficient', 'Settings changed since the last analysis' +
      (state.staleReason ? ' (' + state.staleReason + ')' : '') +
      '. Click ANALYSE first, so the areas match the settings on screen.');
    return;
  }
  var problem = detectionProblem(a);
  if (problem) { setStatus('insufficient', problem); return; }
  var snap = {threshold: thresholdSlider.getValue(), minPx: minPxSlider.getValue(),
              minAbs: minAbsSlider.getValue()};
  invalidateDetection(null);
  var t = newToken('detect');
  setStatus('working', 'Looking for areas that changed by ' + snap.threshold + '% or more...');

  var res = buildClusters(a.pct, a.abs, a.cur, a.base, a.region, snap.threshold,
                          snap.minPx, snap.minAbs);
  var props = detectionProvenance(a, snap);
  var polygons = res.polygons.map(function(f) { return f.set(props); });
  var points = polygons.map(function(f) { return f.centroid(1); });

  ee.Dictionary({
    n: polygons.size(),
    bands: polygons.aggregate_histogram('change_band'),
    area: polygons.aggregate_sum('area_km2')
  }).evaluate(function(r, err) {
    if (!isCurrent('detect', t)) return;
    if (err || !r || !isNum(r.n) || r.n < 0) {
      setStatus('failed', 'Detection failed: ' + errText(err) + '. No result was ' +
        'produced, which is not the same as "no change". Try a smaller area or a larger ' +
        'minimum area size.');
      return;
    }
    state.detection = {
      token: t, analysisToken: a.token, settings: snap, classImage: res.classImage,
      polygons: polygons, points: points, count: r.n, bands: r.bands,
      areaKm2: r.area, props: props
    };
    writeUrl();
    renderResults();
    if (viewSelect.getValue() === 'nodes') updateView('nodes');
    else viewSelect.setValue('nodes');
    var msg = 'Found ' + r.n + ' area' + (r.n === 1 ? '' : 's') + ' that changed by ' +
      snap.threshold + '% or more. They are outlined on the map.';
    if (r.n === 0) msg = 'No areas changed by ' + snap.threshold + '% or more. This is a real ' +
      'result, not a failure.';
    if (r.n > MAX_LINK_FEATURES) msg += ' Large result: use Export to Google Drive.';
    var cautions = analysisCautions(a);
    if (cautions) msg += ' ' + cautions;
    if (a.verdict && a.verdict.kind === 'insufficient') msg += ' See the cautions in the summary.';
    setStatus(cautions || (a.verdict && a.verdict.kind === 'insufficient') ? 'insufficient' : 'ok', msg);
    if (onDone) onDone();
  });
}
detectBtn.onClick(function() { detectNow(); });

// ═══════════════════════════════════════
// 18) DOWNLOADS
// ═══════════════════════════════════════
function exportBaseName(a, d) {
  var b = a.aoi.bbox || [0, 0, 0, 0];
  return safeName('DLV' + VERSION.replace('.', '') + '_' +
    coordTag((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) + '_' +
    idxToYM(a.windows.base.end) + '_vs_' + idxToYM(a.windows.cur.end) +
    (d ? '_t' + d.settings.threshold : ''));
}

exportBtn.onClick(function() {
  var a = state.analysis;
  var d = state.detection;
  if (!a || !d || d.analysisToken !== a.token) {
    setStatus('insufficient', 'Detect change areas first. Downloads always use the detected ' +
                              'result and the settings it was made with.');
    return;
  }
  var t = newToken('export');
  clearExportPanel();
  exportPanel.style().set('shown', true);
  exportPanel.add(ui.Label('Links for ' + d.count + ' change areas (±' + d.settings.threshold +
    '%, ≥ ' + Number(d.settings.minAbs).toFixed(2) + ' nW, minimum ' + d.settings.minPx +
    ' px). Links expire after a few hours.', S_HINT));
  if (d.count > MAX_LINK_FEATURES) {
    exportPanel.add(ui.Label('Over ' + MAX_LINK_FEATURES + ' features: these links may fail. ' +
                             'Use Export to Google Drive.', S_HINT));
  }
  var base = exportBaseName(a, d);
  var fields = CLUSTER_FIELDS.concat(Object.keys(d.props));
  var aoiProps = analysisProvenance(a);
  var aoiFc = ee.FeatureCollection([ee.Feature(a.region, aoiProps)]);
  var jobs = [
    // GeoJSON needs '.geo' in the field list, or Earth Engine writes null
    // geometry. KML keeps geometry regardless.
    {label: 'Centroids (GeoJSON)', fc: d.points, format: 'geojson', name: base + '_points', fields: fields.concat(['.geo'])},
    {label: 'Polygons (GeoJSON)', fc: d.polygons, format: 'geojson', name: base + '_polygons', fields: fields.concat(['.geo'])},
    {label: 'Centroids (CSV)', fc: d.points, format: 'csv', name: base + '_points', fields: fields},
    {label: 'Centroids (KML)', fc: d.points, format: 'kml', name: base + '_points', fields: fields},
    {label: 'Analysed area (GeoJSON)', fc: aoiFc, format: 'geojson', name: base + '_area',
     fields: Object.keys(aoiProps).concat(['.geo'])}
  ];
  jobs.forEach(function(j) {
    j.fc.getDownloadURL(j.format, j.fields, j.name, function(url, err) {
      if (!isCurrent('export', t)) return;
      if (err || !url) {
        exportPanel.add(ui.Label('❌ ' + j.label + ': ' + errText(err, 'no link returned'),
                                 {fontSize: '11px', color: '#c62828'}));
        return;
      }
      exportPanel.add(ui.Label('⬇ ' + j.label, {fontSize: '12px', color: '#1a73e8',
                                                  margin: '2px 0'}).setUrl(url));
    });
  });
});

driveBtn.onClick(function() {
  var a = state.analysis;
  var d = state.detection;
  if (!a || !d || d.analysisToken !== a.token) {
    setStatus('insufficient', 'Detect change areas first.');
    return;
  }
  if (typeof Export === 'undefined') {
    setStatus('failed', 'Export to Drive is only available in the Code Editor.');
    return;
  }
  var base = exportBaseName(a, d);
  var fields = CLUSTER_FIELDS.concat(Object.keys(d.props));
  try {
    Export.table.toDrive({collection: d.polygons.select(fields), description: base + '_polygons',
                          fileFormat: 'GeoJSON'});
    Export.table.toDrive({collection: d.points.select(fields), description: base + '_points',
                          fileFormat: 'CSV'});
    setStatus('info', 'Two export tasks created. Open the Tasks tab and click RUN on each.');
  } catch (e) {
    setStatus('failed', 'Export to Drive failed: ' + e.message);
  }
});

// ═══════════════════════════════════════
// 19) MAP CLICKS: PIXEL VALUES AND TIME SERIES
// ═══════════════════════════════════════
function showPixelDetails(coords) {
  var t = newToken('click');
  var a = state.analysis;
  var pt = ee.Geometry.Point([coords.lon, coords.lat]);
  var minObs = a ? a.settings.minObs : minObsSlider.getValue();
  var ic = applyQuality(VIIRS_BY_CODE[a ? a.dataset.code : 'VCMCFG'].filterDate('2012-04-01',
    idxToDate((a ? a.windows.cur.end : state.latest) + 1)), minObs);

  var regions = ee.FeatureCollection([
    ee.Feature(pt, {label: 'This spot'}),
    ee.Feature(pt.buffer(1000), {label: 'Average within 1 km'})
  ]);
  var chart = ui.Chart.image.seriesByRegion(ic, regions, ee.Reducer.mean(), 'avg_rad',
                                            NATIVE_SCALE_M, 'system:time_start', 'label');
  chart.setOptions({
    title: 'Night-time brightness by month',
    vAxis: {title: 'Brightness'},
    hAxis: {format: 'yyyy', gridlines: {count: 8}},
    lineWidth: 1,
    pointSize: 2,
    interpolateNulls: false,
    legend: {position: 'bottom'},
    chartArea: {width: '82%', height: '60%'},
    height: 170
  });

  var pointInfo = ui.Label(a ? 'Reading pixel values...' :
    'Run ANALYSE to see baseline and comparison values here.',
    {fontSize: '11px', margin: '2px 4px', whiteSpace: 'pre-wrap'});
  var closeBtn = ui.Button({label: '✕', style: {margin: '2px', padding: '0'}});
  closeBtn.onClick(function() {
    chartPanel.style().set('shown', false);
    legendCollapsed = false;
    updateLegend(viewSelect.getValue());
  });

  chartPanel.clear();
  chartPanel.add(hrow([
    ui.Label('📍 ' + coords.lat.toFixed(4) + ', ' + coords.lon.toFixed(4),
             {fontWeight: 'bold', fontSize: '12px', margin: '6px 4px', stretch: 'horizontal'}),
    closeBtn
  ]));
  chartPanel.add(pointInfo);
  chartPanel.add(chart);
  var cosLat = Math.max(0.05, Math.cos(coords.lat * Math.PI / 180));
  var nPix = Math.round(Math.PI * 1e6 / (NATIVE_SCALE_M * NATIVE_SCALE_M * cosLat));
  chartPanel.add(ui.Label('Gaps are months the satellite could not see clearly. The "average ' +
    'within 1 km" line covers about ' + nPix + ' nearby spots; the other line is the spot you clicked.',
    {fontSize: '10px', color: '#666', margin: '0 4px 4px 4px', whiteSpace: 'pre-wrap'}));
  chartPanel.style().set('shown', true);
  if (!legendCollapsed) { legendCollapsed = true; updateLegend(viewSelect.getValue()); }

  if (!a) return;
  ee.Image.cat([a.cur.rename('cur'), a.base.rename('base'), a.pctRaw.rename('pct'),
                a.nCur, a.nBase, a.nMatched, a.footprint.rename('lit'), a.enough,
                ee.Image.constant(1).clip(a.region).rename('inside')])
    .reduceRegion({reducer: ee.Reducer.first(), geometry: pt, crs: GRID})
    .evaluate(function(v, err) {
      if (!isCurrent('click', t) || state.analysis !== a) return;
      if (err || !v) {
        pointInfo.setValue('❌ Could not read pixel values: ' + errText(err) + '.');
        return;
      }
      var lines = [
        'Earlier period: ' + (isNum(v.base) ? fmt(v.base, 2) + ' brightness' : 'no reading'),
        'Later period: ' + (isNum(v.cur) ? fmt(v.cur, 2) + ' brightness' : 'no reading'),
        'Months seen clearly in both periods: ' + v.n_matched + ' of ' + a.windows.cur.months +
          ' (needs ' + a.minValid + '). The two values above average those months.',
        'Change: ' + (v.enough && v.lit && isNum(v.pct) ? fmtSigned(v.pct, 1) + '%' :
          'not calculated here (see below)')
      ];
      if (v.inside !== 1) {
        lines.unshift('⚠️ This spot is outside the area you analysed, so it is not part of ' +
                      'the result. The values below are for reference only.');
      }
      if (isNum(v.base) && v.base < PCT_FLOOR) lines.push('This spot was very dim before, so ' +
        'the percentage can exaggerate. Look at the amount of change instead.');
      if (!v.lit && (!v.n_cur || !v.n_base)) {
        lines.push('No clear view in ' + (!v.n_cur && !v.n_base ? 'either period' :
          (!v.n_cur ? 'the later period' : 'the earlier period')) +
          ', so whether it is lit is unknown.');
      } else if (!v.lit) {
        lines.push('Too dark in both periods to measure.');
      }
      else if (!v.enough) lines.push('Not enough clear-sky months here to compare fairly, so ' +
        'it is left out of the totals.');
      else if (isNum(v.pct) && v.inside === 1 && isNum(v.base) && isNum(v.cur) &&
               Math.max(v.base, v.cur) < PCT_FLOOR) {
        lines.push('Both periods are too dim here for a percentage to mean much.');
      }
      else if (isNum(v.pct) && v.inside === 1) {
        lines.push('In plain terms: ' + plainSentence('this spot is', v.pct, 'the earlier period'));
      }
      if (state.analysisStale) lines.push('(Values from the last analysis; settings have changed since.)');
      pointInfo.setValue(lines.join('\n'));
    });
}

function handleMapClick(coords) {
  if (state.latest === null) { setStatus('working', 'Wait for the archive dates to load.'); return; }
  if (state.drawing) return;   // clicks are adding vertices to a shape
  if (state.awaitingAdminPick) { pickAdmin(coords); return; }
  showPixelDetails(coords);
}
leftMap.onClick(handleMapClick);
rightMap.onClick(handleMapClick);

// ═══════════════════════════════════════
// 20) LINKS (URL PARAMETERS)
// ═══════════════════════════════════════
// Windows are always written as fixed months, so a link reproduces the same
// comparison even after newer data arrives.
function writeUrl() {
  var a = state.analysis;
  if (!a) return;
  try {
    var p = {
      v: VERSION,
      be: idxToYM(a.windows.base.end),
      ce: idxToYM(a.windows.cur.end),
      len: a.windows.cur.months,
      ds: a.settings.dataset,
      obs: a.settings.minObs,
      valid: a.settings.minValidPct,
      lit: a.settings.litThreshold,
      off: a.settings.excludeOffshore ? 1 : 0,
      view: (viewSelect.getValue() === 'nodes' && !state.detection) ? 'pct' : viewSelect.getValue()
    };
    if (a.windows.overlap) p.ov = 1;
    if (a.aoi.kind === 'admin' && a.aoi.admin) {
      p.adm = a.aoi.admin.level;
      if (a.aoi.admin.name) {
        p.aname = a.aoi.admin.name;
      } else {
        p.alon = Number(a.aoi.admin.lon.toFixed(5));
        p.alat = Number(a.aoi.admin.lat.toFixed(5));
      }
    } else if (a.aoi.linkGeo) {
      p.geo = a.aoi.linkGeo;            // drawn or pasted shape, stored in full
    } else if (a.aoi.bbox) {
      p.bbox = a.aoi.bbox.join(',');
      // A drawn or pasted shape too detailed for a link keeps only its box.
      if (a.aoi.approx || a.aoi.kind === 'drawn' || a.aoi.kind === 'geojson') p.approx = 1;
    }
    var d = state.detection;
    if (d && d.analysisToken === a.token) {
      p.det = 1;
      p.thr = d.settings.threshold;
      p.px = d.settings.minPx;
      p.mabs = d.settings.minAbs;
    }
    ui.url.set(p);
  } catch (e) { /* links are optional */ }
}

function readUrlState() {
  function g(k) {
    try {
      var v = ui.url.get(k);
      return (v === undefined || v === null || v === '') ? null : String(v);
    } catch (e) { return null; }
  }
  var geo = null;
  try {
    var rawGeo = ui.url.get('geo');
    if (rawGeo !== undefined && rawGeo !== null && rawGeo !== '') {
      geo = typeof rawGeo === 'string' ? rawGeo : JSON.stringify(rawGeo);
    }
  } catch (e) { geo = null; }
  var bbox = g('bbox');
  var adm = g('adm');
  if (!geo && !bbox && adm === null) return null;
  var st = {};
  if (geo) {
    st.aoi = {kind: 'geojson', text: geo};
  } else if (bbox) {
    var b = bbox.split(',').map(Number);
    if (b.length !== 4 || b.some(function(x) { return !isFinite(x); })) {
      return {error: 'The link has an invalid bbox.'};
    }
    st.aoi = {kind: 'bbox', bbox: b, approx: g('approx') === '1'};
  } else {
    if (['0', '1', '2'].indexOf(adm) < 0) return {error: 'The link has an invalid admin level.'};
    var an = g('aname');
    var alon = g('alon');
    var alat = g('alat');
    if (an) st.aoi = {kind: 'admin', level: adm, name: an};
    else if (alon !== null && alat !== null && isFinite(Number(alon)) && isFinite(Number(alat))) {
      st.aoi = {kind: 'admin', level: adm, lon: Number(alon), lat: Number(alat)};
    } else {
      return {error: 'The link names an admin level but no area.'};
    }
  }
  var be = parseYM(g('be'));
  var ce = parseYM(g('ce'));
  var len = Number(g('len'));
  if (be !== null && ce !== null && [1, 3, 6, 12].indexOf(len) >= 0) {
    st.comparison = {type: 'custom', baselineEnd: be, currentEnd: ce, months: len,
                     allowOverlap: g('ov') === '1'};
  } else if (g('cmp') && PERIODS[g('cmp')]) {
    st.comparison = {type: 'preset', key: g('cmp')};
  }
  if (!st.comparison) return {error: 'The link is missing valid comparison dates.'};
  st.dataset = ['auto', 'standard', 'corrected'].indexOf(g('ds')) >= 0 ? g('ds') : null;
  st.minObs = clampNum(g('obs'), 1, 5, null);
  // Before v3.4, 'valid' meant valid months in each window. It now means
  // matched months, so links from older versions keep the new default.
  var linkVersion = parseFloat(g('v'));
  st.minValidPct = isNum(linkVersion) && linkVersion >= 3.4 ? clampNum(g('valid'), 25, 100, null) : null;
  st.lit = clampNum(g('lit'), 0.5, 5, null);
  st.off = g('off') === '1';
  st.view = VIEW_VALUES.indexOf(g('view')) >= 0 ? g('view') : null;
  // A change-areas view without detection settings would open on "No change areas yet".
  if (st.view === 'nodes' && g('det') !== '1') st.view = 'pct';
  st.detect = g('det') === '1';
  st.thr = clampNum(g('thr'), 10, 90, null);
  st.px = clampNum(g('px'), 1, 50, null);
  st.mabs = clampNum(g('mabs'), 0, 5, null);
  return st;
}

function applyUrlState(st) {
  if (st.dataset) datasetSelect.setValue(st.dataset);
  if (st.minObs !== null) minObsSlider.setValue(st.minObs);
  if (st.minValidPct !== null) minValidSlider.setValue(st.minValidPct);
  if (st.lit !== null) litSlider.setValue(st.lit);
  offshoreCheckbox.setValue(st.off);
  if (st.thr !== null) thresholdSlider.setValue(st.thr);
  if (st.px !== null) minPxSlider.setValue(st.px);
  if (st.mabs !== null) minAbsSlider.setValue(st.mabs);
  if (st.comparison && st.comparison.type === 'custom') {
    setCustomWindows(st.comparison.baselineEnd, st.comparison.currentEnd, st.comparison.months,
                     st.comparison.allowOverlap);
  } else if (st.comparison) {
    customCheckbox.setValue(false);
    periodSelect.setValue(st.comparison.key);
  }
  // The controls now show exactly what the link describes, so the analysis
  // uses them directly and a rerun reproduces it.
  var settings = readSettings();

  // Detection switches to the change-area view when it finishes, so the
  // view saved in the link is applied after it.
  var after = function() {
    if (st.detect) {
      detectNow(function() { if (st.view) viewSelect.setValue(st.view); });
    } else if (st.view) {
      viewSelect.setValue(st.view);
    }
  };
  if (st.aoi.kind === 'geojson') {
    aoiModeSelect.setValue('geojson');
    geojsonBox.setValue(st.aoi.text);
    var parsed;
    try { parsed = parseGeoJsonAoi(st.aoi.text); }
    catch (e) { setStatus('failed', 'Invalid polygon geometry in link: ' + e.message); return; }
    if (parsed.error) {
      setStatus('failed', 'Could not read the shape in the link: ' + parsed.error);
      return;
    }
    var shapeAoi = setPendingAoi({geometry: parsed.geometry, kind: 'geojson',
                                  desc: 'Shape from link (' + parsed.summary + ')'});
    leftMap.centerObject(parsed.geometry);
    runAnalysis(shapeAoi, settings, after);
    return;
  }
  if (st.aoi.kind === 'bbox' && st.aoi.approx) {
    aoiModeSelect.setValue('geojson');
    setStatus('insufficient', 'This link contains only a bounding box of a detailed shape. ' +
      'Paste the original analysed-area GeoJSON to reproduce the analysis. No rectangle was analysed.');
    return;
  }
  if (st.aoi.kind === 'bbox') {
    var geom = boundsToGeometry(st.aoi.bbox);
    aoiModeSelect.setValue('view');
    leftMap.centerObject(geom);
    runAnalysis({geometry: geom, kind: 'bbox', bbox: st.aoi.bbox, part: 'view',
                 approx: st.aoi.approx,
                 desc: st.aoi.approx
                   ? 'Bounding box ' + st.aoi.bbox.join(', ') + ' of a shape too detailed for a link'
                   : 'Rectangle from link ' + st.aoi.bbox.join(', ')}, settings, after);
    return;
  }
  aoiModeSelect.setValue('admin');
  adminLevelSelect.setValue(st.aoi.level);
  var cb = function(aoi, err) {
    if (!aoi) { setStatus('failed', 'Could not load the area from the link: ' + err + '.'); return; }
    setPendingAoi(aoi);
    leftMap.centerObject(aoi.geometry);
    runAnalysis(aoi, settings, after);
  };
  if (st.aoi.name) resolveNamedAdmin(st.aoi.level, st.aoi.name, cb);
  else resolveAdminAtPoint(st.aoi.level, st.aoi.lon, st.aoi.lat, cb);
}

// ═══════════════════════════════════════
// 21) STORY LOCATIONS
// ═══════════════════════════════════════
function applyStoryPreset(i, thenRun) {
  if (state.latest === null) return;   // windows need the archive dates
  var p = STORY_PRESETS[i];
  newToken('admin');
  state.activePreset = i;
  datasetSelect.setValue(p.dataset || 'auto');
  leftMap.setCenter(p.lon, p.lat, p.zoom);
  if (p.baselineEnd) {
    setCustomWindows(parseYM(p.baselineEnd), state.latest, p.months, false);
  } else {
    customCheckbox.setValue(false);
    periodSelect.setValue(p.period);
  }
  if (p.admin) {
    aoiModeSelect.setValue('admin');
    adminLevelSelect.setValue(p.admin.level);
    setStatus('working', 'Loading the ' + p.admin.name + ' boundary...');
    resolveNamedAdmin(p.admin.level, p.admin.name, function(aoi, err) {
      if (!aoi) {
        state.aoiByKind.admin = null;
        refreshAoiInfo();
        showPendingOutline();
        refreshStale('Boundary lookup failed');
        setStatus('failed', 'Boundary lookup failed (' + err + '). No replacement rectangle was ' +
          'analysed. Pick a boundary, draw a shape or explicitly select Current map view.');
        return;
      }
      setPendingAoi(aoi);
      if (thenRun) analyzeNow();
      else setStatus('info', p.name + ': click ANALYSE.');
    });
  } else {
    aoiModeSelect.setValue('view');
    setStatus('info', p.name + ': click ANALYSE to analyse the map view.');
  }
}

locationSelect.onChange(function(v) {
  if (v === null || v === undefined) return;
  applyStoryPreset(Number(v), false);
});

// Clears the story label once the map has moved well away from it, so a
// screenshot never shows one place's name over another place.
leftMap.onChangeBounds(function() {
  if (state.activePreset === null) return;
  var b = getViewBBox(leftMap);
  if (!b) return;
  var p = STORY_PRESETS[state.activePreset];
  var cx = (b[0] + b[2]) / 2;
  var cy = (b[1] + b[3]) / 2;
  if (Math.abs(cx - p.lon) > 0.5 || Math.abs(cy - p.lat) > 0.5) {
    state.activePreset = null;
    try { locationSelect.setValue(null, false); } catch (e) { /* cosmetic only */ }
  }
});

// ═══════════════════════════════════════
// 22) SELF-TESTS (Console tab, Code Editor)
// ═══════════════════════════════════════
function runSelfTests() {
  function check(name, ok, detail) {
    print((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  }
  print('Dark Light Viewer v' + VERSION + ' self-tests. EE tests print as they finish.');

  // --- Client-side logic ---
  var L = ymIndex(2026, 7);
  var w1 = buildWindows({type: 'preset', key: 'y1'}, L);
  var w1m = buildWindows({type: 'preset', key: 'm1'}, L);
  check('T1 preset windows are right and do not overlap (12 months; latest month vs the one before)',
        !w1.error && w1.overlap === 0 &&
        windowLabel(w1.cur) === 'Aug 2025 to Jul 2026 (12 mo)' &&
        windowLabel(w1.base) === 'Aug 2024 to Jul 2025 (12 mo)' &&
        !w1m.error && w1m.overlap === 0 &&
        windowLabel(w1m.cur) === 'Jul 2026 (1 mo)' && windowLabel(w1m.base) === 'Jun 2026 (1 mo)',
        w1.error || w1m.error || windowLabel(w1.base) + ' vs ' + windowLabel(w1.cur) + '; ' +
        windowLabel(w1m.base) + ' vs ' + windowLabel(w1m.cur));

  var w2 = buildWindows({type: 'custom', baselineEnd: ymIndex(2020, 1), currentEnd: L, months: 12}, L);
  check('T2 custom baseline ending Jan 2020 covers Feb 2019 to Jan 2020 only',
        !w2.error && windowRange(w2.base)[0] === '2019-02-01' && windowRange(w2.base)[1] === '2020-02-01',
        w2.error || windowRange(w2.base).join(' to '));

  var w3 = buildWindows({type: 'custom', baselineEnd: ymIndex(2023, 9), currentEnd: L, months: 12}, L);
  check('T3 Gaza baseline contains no month after Sep 2023',
        !w3.error && w3.base.end === ymIndex(2023, 9) && w3.base.start === ymIndex(2022, 10),
        w3.error || windowLabel(w3.base));

  var w4 = buildWindows({type: 'custom', baselineEnd: L - 1, currentEnd: L, months: 3}, L);
  check('T4 overlapping custom windows are refused', !!w4.error && w4.error.indexOf('overlap') >= 0,
        w4.error);

  var w5 = buildWindows({type: 'preset', key: 'm1overlap'}, L);
  check('T5 the labelled overlapping option reports its 2-month overlap', !w5.error && w5.overlap === 2,
        w5.error || 'overlap ' + w5.overlap);

  var w6 = buildWindows({type: 'preset', key: 'y10'}, ymIndex(2022, 1));
  check('T6 windows before April 2012 are refused', !!w6.error, w6.error);

  var w7 = buildWindows({type: 'custom', baselineEnd: L - 12, currentEnd: L + 1, months: 12}, L);
  check('T7 windows after the latest month are refused', !!w7.error, w7.error);

  var w8 = buildWindows({type: 'custom', baselineEnd: L, currentEnd: L - 12, months: 12}, L);
  check('T8 a baseline after the comparison is refused', !!w8.error, w8.error);

  var Lp = ymIndex(2026, 8);
  var pk = pairMonths(buildWindows({type: 'custom', baselineEnd: ymIndex(2023, 3),
                                    currentEnd: Lp, months: 12}, Lp));
  check('T21 12-month windows starting in different months pair by calendar month (Sep 2022 with Sep 2025)',
        pk.calendar && pk.pairs.length === 12 && pk.pairs[0][0] === ymIndex(2022, 9) &&
        pk.pairs[0][1] === ymIndex(2025, 9), JSON.stringify(pk.pairs[0]));
  check('T22 latest month vs the month before is paired in order, flagged as non-calendar',
        !pairMonths(w1m).calendar);
  var py = pairMonths(buildWindows({type: 'preset', key: 'yoy3'}, Lp));
  check('T23 same 3 months a year earlier pair by calendar month', py.calendar &&
        py.pairs.every(function(p) { return idxMonth(p[0]) === idxMonth(p[1]); }));
  var wHi = buildWindows({type: 'preset', key: 'y5'}, Lp);
  var wOld = buildWindows({type: 'custom', baselineEnd: ymIndex(2013, 12), currentEnd: Lp, months: 12}, Lp);
  var r1 = resolveDataset('auto', wHi, 50), r2 = resolveDataset('auto', wHi, 15.6),
      r3 = resolveDataset('auto', wOld, 50), r4 = resolveDataset('corrected', wOld, 50);
  check('T24 auto dataset: corrected at 50°N, standard at 15.6°N (Khartoum), standard fallback before 2014, manual corrected before 2014 refused',
        r1.ds && r1.ds.code === 'VCMSLCFG' && r2.ds && r2.ds.code === 'VCMCFG' &&
        r3.ds && r3.ds.code === 'VCMCFG' && r3.fallback && !!r4.error,
        [r1.ds && r1.ds.code, r2.ds && r2.ds.code, r3.ds && r3.ds.code, !!r4.error].join(', '));
  check('T9 minimum valid months (12 @ 50% = 6, 3 @ 50% = 2, 1 = 1)',
        minValidMonths(12, 50) === 6 && minValidMonths(3, 50) === 2 && minValidMonths(1, 50) === 1);

  var k1 = newToken('selftest');
  var k2 = newToken('selftest');
  check('T10 an older request is ignored after a newer one starts',
        !isCurrent('selftest', k1) && isCurrent('selftest', k2));

  var gOk = parseGeoJsonAoi('{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}');
  var gFc = parseGeoJsonAoi('{"type":"FeatureCollection","features":[{"type":"Feature",' +
    '"geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]},"properties":{}}]}');
  var gBad = parseGeoJsonAoi('{not json');
  var gPt = parseGeoJsonAoi('{"type":"Point","coordinates":[0,0]}');
  check('T11 GeoJSON: polygons accepted; bad JSON and points refused',
        !gOk.error && !gFc.error && !!gBad.error && !!gPt.error);

  check('T12 download names are file-safe',
        safeName('Gaza Strip: 2023/09 vs 2026-07') === 'Gaza_Strip_2023_09_vs_2026-07',
        safeName('Gaza Strip: 2023/09 vs 2026-07'));

  check('T13 radiance-sum change maths', solChange({sum_cur: 25, sum_base: 100}) === -75 &&
        solChange({sum_cur: 5, sum_base: 0}) === null);

  // --- Earth Engine tests on synthetic data ---
  GRID.nominalScale().evaluate(function(m, err) {
    check('T14 analysis grid is the native VIIRS grid (~463.8 m)',
          !err && Math.abs(m - NATIVE_SCALE_M) < 1, err || fmt(m, 2) + ' m');
  });

  // Months with zero cloud-free observations must not count as darkness.
  function synth(v, c, m) {
    return ee.Image.cat([ee.Image.constant(v).toFloat().rename('avg_rad'),
                         ee.Image.constant(c).toInt().rename('cf_cvg')])
      .set('system:time_start', ee.Date('2020-01-01').advance(m, 'month').millis());
  }
  var synthIC = ee.ImageCollection([synth(10, 3, 0), synth(0, 0, 1), synth(12, 2, 2), synth(0, 0, 3)]);
  var q = applyQuality(synthIC, 1);
  var pt = ee.Geometry.Point([10, 10]);
  ee.Dictionary({
    qmean: q.mean().reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('avg_rad'),
    qcount: q.count().reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('avg_rad'),
    rawmean: synthIC.select('avg_rad').mean().reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M)
      .get('avg_rad')
  }).evaluate(function(r, err) {
    if (err || !r) { check('T15 months with no observations are removed', false, err); return; }
    check('T15 months with no observations are removed (mean 11 from 2 valid months)',
          Math.abs(r.qmean - 11) < 1e-6 && r.qcount === 2,
          'mean ' + r.qmean + ' from ' + r.qcount + ' months; counting gaps as zero would give ' + r.rawmean);
  });

  // Matched months: Jun is invalid in the baseline and Jul in the comparison,
  // so both months are dropped from BOTH means. The baseline Jul value (100)
  // must not reach the baseline mean.
  var mBase = [], mCur = [];
  for (var mi = 0; mi < 12; mi++) {
    mBase.push(mi === 5 ? synth(0, 0, mi) : synth(mi === 6 ? 100 : 10, 2, mi));
    mCur.push(mi === 6 ? synth(0, 0, 12 + mi) : synth(20, 2, 12 + mi));
  }
  var mWin = {base: makeWindow(ymIndex(2020, 12), 12), cur: makeWindow(ymIndex(2021, 12), 12)};
  var mm = matchedMeans(applyQuality(ee.ImageCollection(mBase), 1),
                        applyQuality(ee.ImageCollection(mCur), 1), pairMonths(mWin).pairs);
  ee.Dictionary({
    n: mm.n.reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('m'),
    base: mm.base.reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('mean_rad'),
    cur: mm.cur.reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('mean_rad')
  }).evaluate(function(r, err) {
    check('T25 matched months: 10 of 12, baseline mean 10 (Jul excluded), comparison mean 20',
      !err && r && r.n === 10 && Math.abs(r.base - 10) < 1e-6 && Math.abs(r.cur - 20) < 1e-6,
      err || JSON.stringify(r));
  });

  VIIRS_BY_CODE.VCMSLCFG.first().select('avg_rad').projection().nominalScale()
    .evaluate(function(m, err) {
      check('T26 the stray-light corrected product uses the same ~463.8 m grid',
            !err && Math.abs(m - NATIVE_SCALE_M) < 1, err || fmt(m, 2) + ' m');
    });

  var empty = windowComposite(ee.ImageCollection([]));
  ee.Dictionary({
    mean: empty.mean.reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('mean_rad'),
    count: empty.count.rename('valid').reduceRegion(ee.Reducer.first(), pt, NATIVE_SCALE_M).get('valid')
  }).evaluate(function(r, err) {
    check('T20 empty archive window stays masked and has zero valid months',
      !err && r && r.mean === null && r.count === 0, err || JSON.stringify(r));
  });

  // A large decrease block, an increase block touching it, and a noise-level
  // block (+160%, but only +0.8 nW) that must not be detected.
  var region = ee.Geometry.Rectangle([10.0, 10.0, 10.6, 10.4], 'EPSG:4326', false);
  var ll = ee.Image.pixelLonLat();
  var lon = ll.select('longitude');
  var lat = ll.select('latitude');
  var inLat = lat.gte(10.05).and(lat.lt(10.30));
  var blockA = lon.gte(10.05).and(lon.lt(10.30)).and(inLat);   // ~60 x 60 px
  var blockB = lon.gte(10.30).and(lon.lt(10.40)).and(inLat);   // ~24 x 60 px, touching A
  var blockC = lon.gte(10.45).and(lon.lt(10.55)).and(inLat);   // noise-level change
  var inAny = blockA.or(blockB).or(blockC);
  var sPct = ee.Image(0).toFloat().where(blockA, -80).where(blockB, 80).where(blockC, 160)
    .updateMask(inAny).rename('pct_change');
  var sAbs = ee.Image(0).toFloat().where(blockA, -8).where(blockB, 8).where(blockC, 0.8)
    .updateMask(inAny).rename('abs_change');
  var sCur = ee.Image(0).toFloat().where(blockA, 2).where(blockB, 18).where(blockC, 1.1)
    .rename('mean_rad');
  var sBase = ee.Image(10).toFloat().where(blockC, 0.3).rename('mean_rad');
  var polys = buildClusters(sPct, sAbs, sCur, sBase, region, 30, 5, 1).polygons;
  ee.Dictionary({
    n: polys.size(),
    classes: polys.aggregate_array('change_class'),
    counts: polys.aggregate_array('pixel_count'),
    means: polys.aggregate_array('mean_change_pct'),
    areas: polys.aggregate_array('area_km2'),
    bands: polys.aggregate_array('change_band')
  }).evaluate(function(r, err) {
    if (err || !r) { check('T16-T19 clustering', false, err); return; }
    var iDec = r.classes.indexOf(1);
    var iInc = r.classes.indexOf(2);
    var decPx = iDec >= 0 ? r.counts[iDec] : null;
    check('T16 a cluster larger than 1,024 px is kept as one area',
          r.n === 2 && iDec >= 0 && decPx > 1024, r.n + ' areas; decrease area ' + decPx + ' px');
    check('T17 touching decrease and increase stay separate, each with its own mean',
          iDec >= 0 && iInc >= 0 && Math.abs(r.means[iDec] + 80) < 0.5 &&
          Math.abs(r.means[iInc] - 80) < 0.5 && r.bands[iDec] === 'decrease >70%' &&
          r.bands[iInc] === 'increase 50-100%',
          'means ' + JSON.stringify(r.means) + ', bands ' + JSON.stringify(r.bands));
    check('T18 area comes from pixel area (~0.212 km² per pixel at 10°N)',
          iDec >= 0 && Math.abs(r.areas[iDec] / decPx - 0.2119) < 0.01,
          iDec >= 0 ? fmt(r.areas[iDec] / decPx, 4) + ' km² per pixel' : 'missing');
    var nInc = r.classes.filter(function(c) { return c === 2; }).length;
    check('T19 a +160% change of only 0.8 nW is not detected (minimum absolute change 1 nW)',
          r.n === 2 && nInc === 1, r.n + ' areas, ' + nInc + ' increase area(s)');
  });
}

// ═══════════════════════════════════════
// 23) START
// ═══════════════════════════════════════
function init() {
  setStatus('working', 'Reading the VIIRS archive dates...');
  VIIRS_RAW.aggregate_max('system:time_start').evaluate(function(ms, err) {
    if (err || !ms) {
      setStatus('failed', 'Could not read the VIIRS archive dates: ' + errText(err, 'empty') +
                          '. Reload the page.');
      return;
    }
    var d = new Date(ms);
    state.latest = ymIndex(d.getUTCFullYear(), d.getUTCMonth() + 1);
    // The corrected product can lag; record its own latest month (does not block start-up).
    VIIRS_BY_CODE.VCMSLCFG.aggregate_max('system:time_start').evaluate(function(ms2, err2) {
      if (err2 || !ms2) return;
      var d2 = new Date(ms2);
      state.latestCorrected = ymIndex(d2.getUTCFullYear(), d2.getUTCMonth() + 1);
    });
    archiveLabel.setValue('Data: monthly composites, ' + idxLabel(ARCHIVE_FIRST) + ' to ' +
                          idxLabel(state.latest) + '. The newest month is often 2 to 3 months old.');
    populateYearSelects();
    analyzeBtn.setDisabled(false);
    locationSelect.setDisabled(false);
    refreshAoiInfo();
    updateWindowsPreview();

    var st = readUrlState();
    if (st && !st.error) {
      applyUrlState(st);
    } else if (st && st.error) {
      setStatus('failed', st.error + ' Correct the link or choose an area and dates manually.');
    } else {
      applyStoryPreset(0, true);
    }
    if (RUN_TESTS && typeof print === 'function') runSelfTests();
  });
}

init();
