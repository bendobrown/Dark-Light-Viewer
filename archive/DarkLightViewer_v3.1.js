/**** Dark Light Viewer v3.1
     Detect and visualize changes in nighttime lights globally.
     
     For researchers, journalists, and analysts investigating:
     - Conflict impacts & humanitarian crises
     - Natural disasters & recovery
     - Economic change & urban development
     - Infrastructure changes & ghost cities
     - Sensor limitation case studies
     
     Data: VIIRS Day/Night Band Monthly Composites (~500m resolution)
     Coverage: Global, April 2012–present
     
     Methodology: Compares rolling mean radiance between current and
     baseline periods. Detected changes are clustered using connected
     components analysis and classified by severity.
     
     Privacy: Uses aggregated radiance only. Cannot identify individuals.
****/

// ═══════════════════════════════════════
// 0) MAPS & LAYOUT
// ═══════════════════════════════════════
var leftMap  = ui.Map();
var rightMap = ui.Map();
leftMap.setOptions('HYBRID');
rightMap.setOptions('SATELLITE');

// Set initial view BEFORE building the layout — Gaza/Middle East framing
leftMap.setCenter(34.2668845, 31.4238675, 10);
rightMap.setCenter(34.2668845, 31.4238675, 10);

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

// ═══════════════════════════════════════
// 1) DATA & CONFIGURATION
// ═══════════════════════════════════════
var VIIRS_IC = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG')
  .select('avg_rad');

// Colorblind-friendly palette (viridis-inspired)
var viirsVis = {
  min: 0, max: 60,
  palette: [
    '000004', '1b0c41', '4a0c6b', '781c6d', 'a52c60',
    'cf4446', 'ed6925', 'fb9b06', 'f7d13d', 'fcffa4'
  ]
};

// Diverging palette for change (colorblind-safe: brown-teal)
var changeVis = {
  min: -100, max: 100,
  palette: ['8c510a', 'bf812d', 'dfc27d', 'f6e8c3', 'f5f5f5',
            'c7eae5', '80cdc1', '35978f', '01665e']
};

// ═══════════════════════════════════════
// 2) HELPER FUNCTIONS
// ═══════════════════════════════════════
function getViewBBox(map) {
  var bnds = map.getBounds();
  if (bnds === null) return null;
  if (Array.isArray(bnds) && bnds.length === 4 && isFinite(bnds[0])) return bnds;
  if (typeof bnds === 'object') {
    if (bnds.coordinates) {
      var coords = bnds.coordinates[0];
      var lons = coords.map(function(c){return c[0];});
      var lats = coords.map(function(c){return c[1];});
      return [Math.min.apply(null,lons), Math.min.apply(null,lats),
              Math.max.apply(null,lons), Math.max.apply(null,lats)];
    }
  }
  return null;  // Return null if bounds can't be resolved — caller must handle
}

function boundsToGeometry(bbox) {
  var w = Math.max(-180, Math.min(180, bbox[0]));
  var s = Math.max( -90, Math.min( 90, bbox[1]));
  var e = Math.max(-180, Math.min(180, bbox[2]));
  var n = Math.max( -90, Math.min( 90, bbox[3]));
  if (e < w) e = w + (360 - (w - e));
  var eps = 1e-6;
  if (Math.abs(e - w) < eps) e = w + eps;
  if (Math.abs(n - s) < eps) n = s + eps;
  return ee.Geometry.Rectangle([w, s, e, n], 'EPSG:4326', false);
}

// ─── Period lookup (replaces two parallel switch statements) ─────────────────
// rollingMonths: how many months to average for each snapshot
// offsetMonths:  how far back to place the baseline snapshot
var PERIOD_CONFIG = {
  '1 month':  {rollingMonths: 3,   offsetMonths: 1},
  '1 year':   {rollingMonths: 12,  offsetMonths: 12},
  '5 years':  {rollingMonths: 12,  offsetMonths: 60},
  '10 years': {rollingMonths: 12,  offsetMonths: 120}
};

function getPeriodConfig(period) {
  return PERIOD_CONFIG[period] || {rollingMonths: 12, offsetMonths: 12};
}

// Rolling mean for a given duration ending at endDate
function rollingMean(endDate, months) {
  var end   = ee.Date(endDate);
  var start = end.advance(-months, 'month');
  return VIIRS_IC.filterDate(start, end).mean().rename('mean_rad');
}

function clearRight() {
  rightMap.layers().reset([]);
}

// ═══════════════════════════════════════
// 3) STATE
// ═══════════════════════════════════════
var computedData = {
  currentMean:  null,
  baselineMean: null,
  absChange:    null,
  pctChange:    null,
  changeNodes:  null,
  region:       null,
  timePeriod:   null,
  mostRecentEnd: null,
  baselineEnd:  null
};

// ═══════════════════════════════════════
// 4) PRESET LOCATIONS
// ═══════════════════════════════════════
var presetLocations = {

  // ⚔️ Conflict & Crisis
  'Gaza Strip — Conflict since Oct 2023':
    {lon: 34.44, lat: 31.42, zoom: 10, period: '5 years'},
  'Mariupol — Russian invasion impact':
    {lon: 37.55, lat: 47.10, zoom: 11, period: '1 year'},
  'Kharkiv — Frontline urban area':
    {lon: 36.25, lat: 49.99, zoom: 10, period: '1 year'},
  'Mosul — Post-ISIS reconstruction':
    {lon: 43.14, lat: 36.34, zoom: 11, period: '5 years'},
  "Sana'a — Yemen crisis":
    {lon: 44.21, lat: 15.35, zoom: 11, period: '5 years'},
  'Khartoum — Sudan conflict':
    {lon: 32.56, lat: 15.59, zoom: 10, period: '1 year'},

  // 🔥 Natural Disasters
  'Lahaina, Hawaii — 2023 wildfire':
    {lon: -156.68, lat: 20.88, zoom: 13, period: '1 year'},

  // 📈 Rapid Growth
  "Egypt's New Administrative Capital — city before its people":
    {lon: 31.75, lat: 30.02, zoom: 11, period: '5 years'},
  'Addis Ababa — African urbanization':
    {lon: 38.75, lat: 9.01, zoom: 10, period: '10 years'},

  // ⚠️ Sensor Limitation Case Studies
  'Luttelgeest, Netherlands — LED transition misread as decline':
    {lon: 5.83, lat: 52.63, zoom: 12, period: '10 years'}
};

// ═══════════════════════════════════════
// 5) UI COMPONENTS
// ═══════════════════════════════════════

// --- Header ---
var headerPanel = ui.Panel({
  widgets: [
    ui.Label('🔦 Dark Light Viewer', {
      fontWeight: 'bold',
      fontSize: '20px',
      margin: '0 0 0 0'
    }),
    ui.Label('Change Detection Tool  v3.1', {
      fontSize: '14px',
      color: '#666',
      margin: '0 0 8px 0'
    })
  ],
  style: {margin: '0 0 4px 0'}
});

// --- Status ---
var statusLabel = ui.Label('⏳ Loading Gaza analysis...', {
  fontSize: '12px',
  color: '#e65100',
  margin: '0 0 8px 0',
  whiteSpace: 'pre-wrap'
});

// --- Main Action Button ---
var analyzeBtn = ui.Button({
  label: '▶  ANALYZE THIS AREA',
  style: {
    stretch: 'horizontal',
    backgroundColor: '#1a73e8',
    fontWeight: 'bold',
    padding: '8px'
  }
});

// --- Time Period ---
var timePeriodLabel = ui.Label('Compare current lights to:', {
  fontSize: '12px',
  fontWeight: 'bold',
  margin: '12px 0 4px 0'
});

var timePeriodSelect = ui.Select({
  items: [
    {label: '1 month ago', value: '1 month'},
    {label: '1 year ago (recommended)', value: '1 year'},
    {label: '5 years ago', value: '5 years'},
    {label: '10 years ago', value: '10 years'}
  ],
  value: '1 year',
  style: {stretch: 'horizontal'}
});

// --- Advanced Settings (collapsible) ---
var showAdvanced = false;
var advancedToggle = ui.Button({
  label: '▶ Advanced settings',
  style: {
    stretch: 'horizontal',
    margin: '8px 0 0 0'
  }
});

var thresholdSlider = ui.Slider({
  min: 10, max: 70, value: 30, step: 5,
  style: {stretch: 'horizontal'}
});

var thresholdInfo = ui.Label('Detection threshold: 30% change', {
  fontSize: '11px',
  color: '#666'
});

var opacitySlider = ui.Slider({
  min: 0.1, max: 1.0, value: 0.85, step: 0.05,
  style: {stretch: 'horizontal'}
});

var opacityInfo = ui.Label('Overlay opacity: 85%', {
  fontSize: '11px',
  color: '#666'
});

// --- Custom baseline date picker (year + month dropdowns) ---
var useCustomDate = false;
var customDateLabel = ui.Label('Custom baseline date:', {
  fontSize: '11px',
  fontWeight: 'bold',
  color: '#333',
  margin: '8px 0 2px 0'
});
var customDateInfo = ui.Label('Compare current lights against a specific month.', {
  fontSize: '10px',
  color: '#888',
  margin: '0 0 4px 0'
});

var currentYear = new Date().getFullYear();
var yearItems = [];
for (var y = currentYear; y >= 2012; y--) {
  yearItems.push(String(y));
}
var customYearSelect = ui.Select({
  items: yearItems,
  value: '2020',
  placeholder: 'Year',
  style: {stretch: 'horizontal', margin: '2px 0'}
});

var monthItems = [
  {label: 'January', value: '01'}, {label: 'February', value: '02'},
  {label: 'March', value: '03'}, {label: 'April', value: '04'},
  {label: 'May', value: '05'}, {label: 'June', value: '06'},
  {label: 'July', value: '07'}, {label: 'August', value: '08'},
  {label: 'September', value: '09'}, {label: 'October', value: '10'},
  {label: 'November', value: '11'}, {label: 'December', value: '12'}
];
var customMonthSelect = ui.Select({
  items: monthItems,
  value: '01',
  placeholder: 'Month',
  style: {stretch: 'horizontal', margin: '2px 0'}
});

var customDatePanel = ui.Panel({
  widgets: [customDateInfo, customYearSelect, customMonthSelect],
  style: {shown: false, margin: '0'}
});

var customDateToggle = ui.Button({
  label: '☐ Use custom baseline date',
  style: {stretch: 'horizontal', margin: '4px 0'}
});

customDateToggle.onClick(function() {
  useCustomDate = !useCustomDate;
  customDateToggle.setLabel(useCustomDate
    ? '☑ Using custom baseline date'
    : '☐ Use custom baseline date');
  customDatePanel.style().set('shown', useCustomDate);
  if (useCustomDate) {
    statusLabel.setValue('📅 Custom date mode — select year and month, then Analyze');
    statusLabel.style().set('color', '#1a73e8');
  }
});

function getCustomBaselineDate() {
  var yr = customYearSelect.getValue();
  var mo = customMonthSelect.getValue();
  if (!yr || !mo) return null;
  return ee.Date(yr + '-' + mo + '-01');
}

var advancedPanel = ui.Panel({
  widgets: [
    thresholdInfo, thresholdSlider,
    opacityInfo, opacitySlider,
    customDateLabel, customDateToggle, customDatePanel
  ],
  style: {shown: false, margin: '4px 0'}
});

advancedToggle.onClick(function() {
  showAdvanced = !showAdvanced;
  advancedPanel.style().set('shown', showAdvanced);
  advancedToggle.setLabel(showAdvanced ? '▼ Advanced settings' : '▶ Advanced settings');
});

thresholdSlider.onChange(function(val) {
  thresholdInfo.setValue('Detection threshold: ' + val + '% change');
});

opacitySlider.onChange(function(val) {
  opacityInfo.setValue('Overlay opacity: ' + Math.round(val * 100) + '%');
  var layers = rightMap.layers();
  for (var i = 0; i < layers.length(); i++) {
    var lyr = layers.get(i);
    if (lyr.getShown()) {
      lyr.setOpacity(val);
    }
  }
});

// --- Preset Locations ---
var locationLabel = ui.Label('Investigate a location:', {
  fontSize: '12px',
  fontWeight: 'bold',
  margin: '12px 0 4px 0'
});

var locationSelect = ui.Select({
  items: Object.keys(presetLocations),
  placeholder: 'Select a story location...',
  style: {stretch: 'horizontal'}
});

locationSelect.onChange(function(key) {
  var loc = presetLocations[key];
  leftMap.setCenter(loc.lon, loc.lat, loc.zoom);
  if (loc.period) {
    timePeriodSelect.setValue(loc.period);
  }
  statusLabel.setValue('📍 ' + key.split('—')[0].trim());
  statusLabel.style().set('color', '#1a73e8');
});

// --- View Mode ---
var viewLabel = ui.Label('View mode:', {
  fontSize: '12px',
  fontWeight: 'bold',
  margin: '12px 0 4px 0'
});

var viewSelect = ui.Select({
  items: [
    {label: '🗺️ Percentage Change Map', value: 'pctChange'},
    {label: '🗺️ Absolute Change Map', value: 'absChange'},
    {label: '📍 Detected Change Nodes', value: 'nodes'},
    {label: '🌃 Current Night Lights', value: 'current'},
    {label: '🌃 Baseline (past)', value: 'baseline'},
    {label: '🎨 Temporal RGB Composite', value: 'composite'}
  ],
  value: 'pctChange',
  style: {stretch: 'horizontal'}
});

// --- Results Summary ---
var resultsPanel = ui.Panel({
  style: {
    backgroundColor: '#f8f9fa',
    padding: '8px',
    margin: '8px 0',
    shown: false
  }
});

// --- Additional Action Buttons ---
var detectNodesBtn = ui.Button({
  label: '📍 Detect Change Nodes',
  style: {stretch: 'horizontal', margin: '4px 0'}
});

var exportBtn = ui.Button({
  label: '📤 Export Change Nodes (GeoJSON)',
  style: {stretch: 'horizontal', margin: '4px 0'}
});

// ═══════════════════════════════════════
// 6) INTERPRETATION GUIDE
// ═══════════════════════════════════════
var guidePanel = ui.Panel({
  widgets: [
    ui.Label('📖 Interpreting Results', {
      fontWeight: 'bold',
      fontSize: '12px',
      margin: '0 0 6px 0'
    }),
    ui.Label('DECREASES (warm colors):', {fontWeight: 'bold', fontSize: '11px', color: '#8c510a'}),
    ui.Label('• >70%: Major event — conflict, disaster, collapse', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• 50–70%: Significant — economic decline, displacement', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• 30–50%: Moderate — industrial closure, depopulation', {fontSize: '10px', margin: '0 0 4px 8px'}),

    ui.Label('INCREASES (cool colors):', {fontWeight: 'bold', fontSize: '11px', color: '#01665e'}),
    ui.Label('• >50%: Rapid urbanization, major construction', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• 30–50%: Steady growth, economic expansion', {fontSize: '10px', margin: '0 0 4px 8px'}),

    ui.Label('⚠️ Limitations:', {fontWeight: 'bold', fontSize: '11px', color: '#666'}),
    ui.Label('• Seasonal variation affects short-period comparisons', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• Cloud/snow cover can reduce readings', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• ~500m resolution — individual buildings not resolved', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• LED lighting is undercounted by ~30% vs sodium lamps', {fontSize: '10px', margin: '0 0 0 8px'}),
    ui.Label('• Stray light at high latitudes may cause artifacts', {fontSize: '10px', margin: '0 0 0 8px'})
  ],
  style: {backgroundColor: '#f0f0f0', padding: '6px', margin: '8px 0'}
});

// --- Citation ---
var citationPanel = ui.Panel({
  widgets: [
    ui.Label('📝 How to Cite', {fontWeight: 'bold', fontSize: '11px', margin: '0 0 4px 0'}),
    ui.Label('Data: VIIRS DNB Monthly Composites (NOAA/EOG). ', {fontSize: '10px'}),
    ui.Label('Tool: Dark Light Viewer v3.1', {fontSize: '10px'}),
    ui.Label('Resolution: ~500m | Coverage: Global, 2012–present', {fontSize: '10px'})
  ],
  style: {backgroundColor: '#e8f0fe', padding: '6px', margin: '8px 0'}
});


// ═══════════════════════════════════════
// 7) ASSEMBLE PANEL
// ═══════════════════════════════════════
var panel = ui.Panel({
  widgets: [
    headerPanel,
    statusLabel,
    analyzeBtn,
    timePeriodLabel,
    timePeriodSelect,
    advancedToggle,
    advancedPanel,
    locationLabel,
    locationSelect,
    viewLabel,
    viewSelect,
    resultsPanel,
    detectNodesBtn,
    exportBtn,
    guidePanel,
    citationPanel
  ],
  style: {
    position: 'top-left',
    width: '330px',
    padding: '10px',
    maxHeight: '95%'
  }
});
leftMap.add(panel);


// ═══════════════════════════════════════
// 8) CORE ANALYSIS (reusable function)
// ═══════════════════════════════════════
function runAnalysis(region, period, customBaselineDate) {
  computedData.region = region;
  computedData.timePeriod = customBaselineDate ? 'custom' : period;

  clearRight();

  // AOI outline
  var outline = ui.Map.Layer(
    ee.FeatureCollection([ee.Feature(region)]).style({color: 'yellow', fillColor: '00000000'}),
    {}, 'AOI', true
  );
  rightMap.layers().add(outline);

  // Find most recent data
  var mostRecentImg = VIIRS_IC.sort('system:time_start', false).first();
  var mostRecentEnd = ee.Date(mostRecentImg.get('system:time_start')).advance(1, 'month');

  var rollingMonths, baselineEnd;

  if (customBaselineDate) {
    rollingMonths = 12;
    baselineEnd = ee.Date(customBaselineDate).advance(6, 'month');
    computedData.timePeriod = 'custom baseline';
  } else {
    var cfg = getPeriodConfig(period);
    rollingMonths = cfg.rollingMonths;
    baselineEnd = mostRecentEnd.advance(-cfg.offsetMonths, 'month');
  }

  computedData.mostRecentEnd = mostRecentEnd;
  computedData.baselineEnd   = baselineEnd;
  computedData.rollingMonths = rollingMonths;  // Store for showComposite to use

  // Compute rolling means
  var currentMean  = rollingMean(mostRecentEnd, rollingMonths).clip(region);
  var baselineMean = rollingMean(baselineEnd,   rollingMonths).clip(region);

  computedData.currentMean  = currentMean;
  computedData.baselineMean = baselineMean;

  // Absolute change
  var absChange = currentMean.subtract(baselineMean).rename('abs_change');
  computedData.absChange = absChange;

  // Percentage change: ((current - baseline) / baseline) * 100
  // Floor baseline at 0.5 nW/cm²/sr to avoid division-by-zero in very dark areas
  var safeBaseline = baselineMean.max(0.5);
  var pctChange = currentMean.subtract(baselineMean)
    .divide(safeBaseline).multiply(100)
    .rename('pct_change');
  computedData.pctChange = pctChange;

  // Reset change nodes (stale nodes from previous region must be cleared)
  computedData.changeNodes = null;

  // Display based on current view selection
  updateView(viewSelect.getValue());

  // Compute summary stats
  var pctStats = pctChange.reduceRegion({
    reducer: ee.Reducer.mean().combine({
      reducer2: ee.Reducer.stdDev(), sharedInputs: true
    }).combine({
      reducer2: ee.Reducer.percentile([10, 50, 90]), sharedInputs: true
    }),
    geometry: region,
    scale: 500,
    maxPixels: 1e9
  });

  pctStats.evaluate(function(result) {
    if (!result) {
      statusLabel.setValue('✅ Analysis complete. Drag the slider to compare.');
      statusLabel.style().set('color', '#4caf50');
      return;
    }
    var mean = result.pct_change_mean || 0;
    var p10  = result.pct_change_p10  || 0;
    var p90  = result.pct_change_p90  || 0;

    var summary = '✅ Analysis complete (' + period + ')\n';
    summary += 'Mean change: ' + mean.toFixed(1) + '%\n';
    summary += 'Range: ' + p10.toFixed(1) + '% to ' + p90.toFixed(1) + '%\n';
    summary += 'Drag the slider to compare. Click map for details.';

    statusLabel.setValue(summary);
    statusLabel.style().set('color', '#4caf50');
  });
}


// ═══════════════════════════════════════
// 9) ANALYZE BUTTON HANDLER
// ═══════════════════════════════════════
analyzeBtn.onClick(function() {
  try {
    statusLabel.setValue('⏳ Loading VIIRS data...');
    statusLabel.style().set('color', '#e65100');

    var period = timePeriodSelect.getValue();
    var bbox = getViewBBox(leftMap);

    // Guard: if bounds are unresolvable, warn the user rather than
    // silently falling back to a global bbox (which would time out)
    if (!bbox) {
      statusLabel.setValue('⚠️ Could not read map bounds. Try zooming or panning, then analyze again.');
      statusLabel.style().set('color', '#d32f2f');
      return;
    }

    var region = boundsToGeometry(bbox);

    if (useCustomDate) {
      var selectedDate = getCustomBaselineDate();
      if (selectedDate) {
        var yr = customYearSelect.getValue();
        var mo = customMonthSelect.getValue();
        statusLabel.setValue('⏳ Comparing current vs ' + yr + '-' + mo + '...');
        runAnalysis(region, period, selectedDate);
      } else {
        statusLabel.setValue('⚠️ Select year and month in Advanced settings');
        statusLabel.style().set('color', '#e65100');
      }
    } else {
      runAnalysis(region, period);
    }

  } catch (e) {
    statusLabel.setValue('❌ Error: ' + e.message + '\nZoom/pan and try again.');
    statusLabel.style().set('color', '#d32f2f');
  }
});


// ═══════════════════════════════════════
// 10) VIEW SWITCHING
// ═══════════════════════════════════════
function updateView(mode) {
  if (!computedData.currentMean) return;

  clearRight();
  var opacity = opacitySlider.getValue();

  // Always re-add AOI outline
  var outline = ui.Map.Layer(
    ee.FeatureCollection([ee.Feature(computedData.region)])
      .style({color: 'yellow', fillColor: '00000000'}),
    {}, 'AOI', true
  );
  rightMap.layers().add(outline);

  switch(mode) {
    case 'pctChange':
      rightMap.layers().add(ui.Map.Layer(
        computedData.pctChange.clip(computedData.region),
        changeVis,
        'Percentage Change (brown=decrease, teal=increase)',
        true, opacity
      ));
      break;

    case 'absChange':
      rightMap.layers().add(ui.Map.Layer(
        computedData.absChange.clip(computedData.region),
        {min: -20, max: 20, palette: changeVis.palette},
        'Absolute Change (nW/cm²/sr)',
        true, opacity
      ));
      break;

    case 'nodes':
      if (computedData.changeNodes) {
        showNodes();
      } else {
        statusLabel.setValue('⚠️ Click "Detect Change Nodes" first');
        statusLabel.style().set('color', '#e65100');
      }
      break;

    case 'current':
      rightMap.layers().add(ui.Map.Layer(
        computedData.currentMean.clip(computedData.region),
        viirsVis, 'Current Night Lights', true, opacity
      ));
      break;

    case 'baseline':
      rightMap.layers().add(ui.Map.Layer(
        computedData.baselineMean.clip(computedData.region),
        viirsVis, 'Baseline Night Lights', true, opacity
      ));
      break;

    case 'composite':
      showComposite();
      break;
  }
}

viewSelect.onChange(function(val) {
  updateView(val);
});


// ═══════════════════════════════════════
// 11) CHANGE NODE DETECTION (fully server-side)
// ═══════════════════════════════════════
detectNodesBtn.onClick(function() {
  if (!computedData.pctChange) {
    statusLabel.setValue('⚠️ Run analysis first');
    return;
  }

  statusLabel.setValue('⏳ Detecting change nodes...');
  statusLabel.style().set('color', '#e65100');

  var threshold = thresholdSlider.getValue();

  // Detect decrease areas (where there was light before)
  var decreaseMask = computedData.pctChange.lt(-threshold)
    .and(computedData.baselineMean.gt(1));

  // Detect increase areas (where there is light now)
  var increaseMask = computedData.pctChange.gt(threshold)
    .and(computedData.currentMean.gt(1));

  var changeMask = decreaseMask.or(increaseMask).selfMask();

  // Connected components clustering
  var connectedPixels = changeMask.connectedPixelCount({
    maxSize: 256, eightConnected: true
  });

  // Filter small clusters (< 5 pixels at 500m ≈ 1.25 km²)
  var significantClusters = changeMask.updateMask(connectedPixels.gte(5));

  var objectId = significantClusters.connectedComponents({
    connectedness: ee.Kernel.plus(1),
    maxSize: 256
  });

  var vectors = objectId.select('labels').reduceToVectors({
    geometry: computedData.region,
    scale: 500,
    maxPixels: 1e9,
    geometryType: 'centroid',
    eightConnected: true,
    labelProperty: 'cluster_id'
  });

  var pctChangeImg  = computedData.pctChange;
  var baselineImg   = computedData.baselineMean;
  var currentImg    = computedData.currentMean;

  var nodesWithStats = vectors.map(function(f) {
    var centroid = f.geometry();
    var buffer   = centroid.buffer(2000);

    var stats = pctChangeImg.reduceRegion({
      reducer: ee.Reducer.mean().combine({
        reducer2: ee.Reducer.count(), sharedInputs: true
      }),
      geometry: buffer,
      scale: 500,
      maxPixels: 1e6
    });

    var meanChange = ee.Number(stats.get('pct_change_mean'));
    var pixCount   = ee.Number(stats.get('pct_change_count'));
    var areaKm2    = pixCount.multiply(0.25);

    var severity = ee.Algorithms.If(meanChange.lt(-70), 'severe',
                   ee.Algorithms.If(meanChange.lt(-50), 'high',
                   ee.Algorithms.If(meanChange.lt(ee.Number(threshold).multiply(-1)), 'moderate',
                   ee.Algorithms.If(meanChange.gt(ee.Number(threshold)), 'growth',
                   'low'))));

    return f.set({
      'mean_change_pct': meanChange,
      'pixel_count':     pixCount,
      'area_km2':        areaKm2,
      'severity':        severity
    });
  });

  computedData.changeNodes = nodesWithStats;

  showNodes();

  nodesWithStats.size().evaluate(function(count) {
    if (count === null || count === undefined) count = 0;
    statusLabel.setValue('✅ Detected ' + count + ' change areas');
    statusLabel.style().set('color', '#4caf50');

    resultsPanel.widgets().reset([]);
    resultsPanel.style().set('shown', true);
    resultsPanel.add(ui.Label('📊 Results Summary', {
      fontWeight: 'bold', fontSize: '12px', margin: '0 0 4px 0'
    }));
    resultsPanel.add(ui.Label('Change areas detected: ' + count, {fontSize: '11px'}));
    resultsPanel.add(ui.Label('Period: ' + computedData.timePeriod, {fontSize: '11px'}));
    resultsPanel.add(ui.Label('Threshold: ' + thresholdSlider.getValue() + '% change', {fontSize: '11px'}));
    resultsPanel.add(ui.Label('Click map to inspect individual areas ↗', {
      fontSize: '10px', fontStyle: 'italic', color: '#666', margin: '4px 0 0 0'
    }));
  });
});


// ═══════════════════════════════════════
// 12) SHOW NODES ON MAP
// ═══════════════════════════════════════
function showNodes() {
  if (!computedData.changeNodes) return;

  clearRight();
  var opacity = opacitySlider.getValue();

  rightMap.layers().add(ui.Map.Layer(
    ee.FeatureCollection([ee.Feature(computedData.region)])
      .style({color: 'yellow', fillColor: '00000000'}),
    {}, 'AOI', true
  ));

  rightMap.layers().add(ui.Map.Layer(
    computedData.currentMean.clip(computedData.region),
    viirsVis, 'Current Lights (background)', true, 0.3
  ));

  var threshold    = thresholdSlider.getValue();
  var decreaseOverlay = computedData.pctChange.lt(-threshold)
    .and(computedData.baselineMean.gt(1)).selfMask();
  var increaseOverlay = computedData.pctChange.gt(threshold)
    .and(computedData.currentMean.gt(1)).selfMask();

  rightMap.layers().add(ui.Map.Layer(
    decreaseOverlay.clip(computedData.region),
    {palette: ['FF4444']}, 'Decrease Areas', true, opacity * 0.4
  ));
  rightMap.layers().add(ui.Map.Layer(
    increaseOverlay.clip(computedData.region),
    {palette: ['44CC66']}, 'Increase Areas', true, opacity * 0.4
  ));

  var nodes = computedData.changeNodes;

  rightMap.layers().add(ui.Map.Layer(
    nodes.filter(ee.Filter.eq('severity', 'severe')).style({color: 'FF0000', pointSize: 7}),
    {}, '🔴 Severe (>70% decrease)', true
  ));
  rightMap.layers().add(ui.Map.Layer(
    nodes.filter(ee.Filter.eq('severity', 'high')).style({color: 'FF6600', pointSize: 6}),
    {}, '🟠 High (50-70% decrease)', true
  ));
  rightMap.layers().add(ui.Map.Layer(
    nodes.filter(ee.Filter.eq('severity', 'moderate')).style({color: 'FFCC00', pointSize: 5}),
    {}, '🟡 Moderate (30-50% decrease)', true
  ));
  rightMap.layers().add(ui.Map.Layer(
    nodes.filter(ee.Filter.eq('severity', 'growth')).style({color: '00CC66', pointSize: 6}),
    {}, '🟢 Growth (increase)', true
  ));
  rightMap.layers().add(ui.Map.Layer(
    nodes.filter(ee.Filter.eq('severity', 'low')).style({color: '66CCFF', pointSize: 4}),
    {}, '🔵 Low (<30% decrease)', true
  ));
}


// ═══════════════════════════════════════
// 13) TEMPORAL RGB COMPOSITE
// ═══════════════════════════════════════
function showComposite() {
  if (!computedData.currentMean || !computedData.baselineMean) return;

  // Guard: custom date analyses don't have a defined period offset,
  // so skip the midpoint calculation and show a two-band composite instead
  if (computedData.timePeriod === 'custom' || computedData.timePeriod === 'custom baseline') {
    var twoband = computedData.baselineMean.addBands(computedData.currentMean);
    rightMap.layers().add(ui.Map.Layer(
      twoband, {min: 0, max: 40},
      'Temporal composite (R:Baseline, B:Current)',
      true, opacitySlider.getValue()
    ));
    statusLabel.setValue(
      'RGB Composite (custom date):\n' +
      '🔴 Red = Baseline lights only\n' +
      '🔵 Blue = Current lights only\n' +
      '⚪ White = Consistent activity'
    );
    statusLabel.style().set('color', '#333');
    return;
  }

  var opacity    = opacitySlider.getValue();
  var cfg        = getPeriodConfig(computedData.timePeriod);
  var midOffset  = Math.round(cfg.offsetMonths / 2);
  var midEnd     = computedData.mostRecentEnd.advance(-midOffset, 'month');
  var midMean    = rollingMean(midEnd, cfg.rollingMonths).clip(computedData.region);

  // RGB: R=baseline (past), G=midpoint, B=current
  var composite = computedData.baselineMean.addBands(midMean)
    .addBands(computedData.currentMean);

  rightMap.layers().add(ui.Map.Layer(
    composite, {min: 0, max: 40},
    'Temporal RGB (R:Past, G:Mid, B:Current)',
    true, opacity
  ));

  statusLabel.setValue(
    'RGB Composite:\n' +
    '🔴 Red = Lights in past only (decline)\n' +
    '🔵 Blue = Recent lights only (growth)\n' +
    '⚪ White = Consistent activity'
  );
  statusLabel.style().set('color', '#333');
}


// ═══════════════════════════════════════
// 14) MAP CLICK — TIME SERIES & DETAILS
// ═══════════════════════════════════════
rightMap.onClick(function(coords) {
  if (!computedData.currentMean) {
    statusLabel.setValue('Run analysis first, then click the map.');
    return;
  }

  var point = ee.Geometry.Point([coords.lon, coords.lat]);

  var currentVal  = computedData.currentMean.reduceRegion({
    reducer: ee.Reducer.first(), geometry: point, scale: 500
  });
  var baselineVal = computedData.baselineMean.reduceRegion({
    reducer: ee.Reducer.first(), geometry: point, scale: 500
  });
  var pctVal = computedData.pctChange.reduceRegion({
    reducer: ee.Reducer.first(), geometry: point, scale: 500
  });

  ee.Dictionary({
    current:  currentVal.get('mean_rad'),
    baseline: baselineVal.get('mean_rad'),
    pct:      pctVal.get('pct_change')
  }).evaluate(function(vals) {
    var cur  = vals.current  !== null ? Number(vals.current).toFixed(2)  : 'N/A';
    var base = vals.baseline !== null ? Number(vals.baseline).toFixed(2) : 'N/A';
    var pct  = vals.pct      !== null ? Number(vals.pct).toFixed(1) + '%' : 'N/A';

    statusLabel.setValue(
      '📍 Location: ' + coords.lat.toFixed(4) + ', ' + coords.lon.toFixed(4) + '\n' +
      'Current radiance: ' + cur + ' nW/cm²/sr\n' +
      'Baseline radiance: ' + base + ' nW/cm²/sr\n' +
      'Change: ' + pct
    );
    statusLabel.style().set('color', '#333');
  });

  var buffer = point.buffer(1000);

  var timeSeries = ui.Chart.image.series({
    imageCollection: VIIRS_IC,
    region: buffer,
    reducer: ee.Reducer.mean(),
    scale: 500,
    xProperty: 'system:time_start'
  }).setOptions({
    title: 'Monthly Radiance at Click Location',
    vAxis: {title: 'Radiance (nW/cm²/sr)', minValue: 0},
    hAxis: {title: '', format: 'MMM yyyy', gridlines: {count: 6}},
    lineWidth: 1.5,
    pointSize: 0,
    colors: ['#1a73e8'],
    curveType: 'function',
    legend: {position: 'none'},
    chartArea: {width: '80%', height: '70%'}
  });

  var chartPanel = ui.Panel({
    widgets: [timeSeries],
    style: {
      position: 'bottom-right',
      width: '400px',
      height: '250px',
      padding: '4px',
      backgroundColor: 'white'
    }
  });

  rightMap.widgets().reset([]);
  rightMap.widgets().add(chartPanel);
});


// ═══════════════════════════════════════
// 15) EXPORT
// ═══════════════════════════════════════
exportBtn.onClick(function() {
  if (!computedData.changeNodes) {
    statusLabel.setValue('⚠️ Detect change nodes first, then export');
    return;
  }

  statusLabel.setValue('⏳ Preparing download link...');
  statusLabel.style().set('color', '#e65100');

  var exportCollection = computedData.changeNodes.map(function(f) {
    return ee.Feature(f.geometry(), {
      mean_change_pct: f.get('mean_change_pct'),
      pixel_count:     f.get('pixel_count'),
      area_km2:        f.get('area_km2'),
      severity:        f.get('severity'),
      cluster_id:      f.get('cluster_id')
    });
  });

  exportCollection.getDownloadURL('GeoJSON', null, 'DarkLightViewer_ChangeNodes', function(url, error) {
    if (error) {
      statusLabel.setValue('❌ Export failed: ' + error);
      statusLabel.style().set('color', '#d32f2f');
      return;
    }

    resultsPanel.widgets().reset([]);
    resultsPanel.style().set('shown', true);
    resultsPanel.add(ui.Label('📤 Export Ready', {
      fontWeight: 'bold', fontSize: '12px', margin: '0 0 4px 0'
    }));
    resultsPanel.add(ui.Label('Click the link below to download:', {
      fontSize: '11px', margin: '0 0 4px 0'
    }));
    resultsPanel.add(ui.Label('⬇ Download GeoJSON', {
      fontSize: '12px',
      color: '#1a73e8',
      margin: '4px 0'
    }).setUrl(url));
    resultsPanel.add(ui.Label('Period: ' + (computedData.timePeriod || '') +
      ' | Threshold: ' + thresholdSlider.getValue() + '%', {
      fontSize: '10px', color: '#666', margin: '4px 0 0 0'
    }));

    statusLabel.setValue('✅ Download link ready — click to save');
    statusLabel.style().set('color', '#4caf50');
  });
});


// ═══════════════════════════════════════
// 16) INITIALIZE — Auto-load Gaza
// ═══════════════════════════════════════
[leftMap, rightMap].forEach(function(m){
  m.setControlVisibility({drawingToolsControl: false, mapTypeControl: false});
});

ui.util.setTimeout(function() {
  try {
    var gazaRegion = ee.Geometry.Rectangle(
      [33.8, 31.0, 34.7, 31.85], 'EPSG:4326', false
    );

    statusLabel.setValue('⏳ Loading Gaza analysis (5-year comparison)...');
    statusLabel.style().set('color', '#e65100');

    timePeriodSelect.setValue('5 years');
    runAnalysis(gazaRegion, '5 years');

  } catch (e) {
    statusLabel.setValue('Ready — Select a location or click ANALYZE');
    statusLabel.style().set('color', '#1a73e8');
  }
}, 2000);
