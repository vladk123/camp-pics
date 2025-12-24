
let parks = [];
let selectedProvince = null;
let parksByProvince = {};
let map;
let currentOverlay = null;
let currentMarkers = [];
let backControl = null;
let activeProvinceLayer = null;
let activeProvinceLi = null;
let parkIdToMarker = {};
const parkIcon = L.icon({
  iconUrl: '/css/images/marker-icon.png',
  iconSize: [33, 41],
  iconAnchor: [16, 41],       // bottom-middle
  popupAnchor: [0, -41]       // straight up, no horizontal offset
});

const parkIconHighlight = L.icon({
  iconUrl: '/css/images/marker-icon-highlight.png',
  iconSize: [33, 41],
  iconAnchor: [16, 41],
  popupAnchor: [0, -41]
});


//////// GLOBAL MAP SETTINGS
const MAP_DEFAULTS = {
  bufferZoom: 0.2,   // how much extra you can zoom OUT beyond "fit"
  maxZoomExtra: 1.1, // how much extra you can zoom IN beyond "fit"
  panBuffer: 20      // how many pixels you can drag past image edge before bounce
};

/* Utility to build bounds from height/width once, in one place */
function makeBounds(height, width) {
  return [[0, 0], [height, width]];
}

/* Ensure an image config has width, height, and bounds in sync */
function ensureImageMetrics(cfg) {
  if (!cfg) return cfg;
  // If width/height missing but bounds exist, derive them
  if ((!cfg.width || !cfg.height) && cfg.bounds) {
    cfg.height = cfg.bounds[1][0];
    cfg.width  = cfg.bounds[1][1];
  }
  // If bounds missing but width/height exist, derive it
  if (!cfg.bounds && cfg.width && cfg.height) {
    cfg.bounds = makeBounds(cfg.height, cfg.width);
  }
  return cfg;
}

///////// CANADA IMAGE CONFIG
const canadaData = ensureImageMetrics({
  imageUrl: '/images/maps/Canada.png',
  width: 1188,   // change here only if the image changes
  height: 1188,  // change here only if the image changes
  // bounds will be auto-filled from width/height
});


//////////// PROVINCE CONFIG
const provinceList = {
  'Alberta': ensureImageMetrics({
    abbrev: 'AB',
    polygon: [    [[608,332],[591,378],[577,425],[507,407],[426,385],[363,368],[378,319],[388,313],[408,316],[431,305],[462,292],[480,288],[494,281],[609,332]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/AB.png',
    width: 1188,
    height: 1188,
    latRange: [61.585492, 46.920255],
    lngRange: [-127.573242, -101.250000]
  }),

  'British Columbia': ensureImageMetrics({
    abbrev: 'BC',
    polygon: [    [705,171],[655,239],[623,302],[611,331],[558,309],[492,281],[468,289],[434,307],[406,317],[388,316],[378,321],[382,304],[402,253],[414,229],[427,204],[449,198],[475,188],[486,180],[507,176],[519,179],[528,174],[542,172],[561,176],[572,178],[585,193],[594,196],[606,192],[617,192],[636,193],[652,195],[666,195],[676,193],[680,189],[681,176],[681,170],[705,172]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/BC.png',
    width: 1224,
    height: 1224,
    latRange: [62.471724, 44.496505],
    lngRange: [-140.537109, -108.676758]
  }),
  'Manitoba': ensureImageMetrics({
    abbrev: 'MB',
    polygon: [    [[561,505],[555,542],[552,581],[531,580],[527,588],[527,596],[513,600],[491,605],[495,621],[492,634],[488,643],[465,622],[429,591],[407,569],[371,566],[334,562],[334,541],[336,511],[340,483],[385,486],[427,488],[474,492],[512,497],[546,504],[559,505],[563,506]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/MB.png',
    width: 1188,
    height: 1188,
    latRange: [61.752331, 45.398450],
    lngRange: [-111.137695, -82.485352]
  }),

  'New Brunswick': ensureImageMetrics({
    abbrev: 'NB',
    polygon: [    [[362,919],[375,937],[379,949],[384,961],[379,967],[368,965],[361,965],[358,972],[355,982],[355,995],[348,986],[336,976],[323,965],[313,957],[323,944],[343,934],[352,925],[353,921],[355,913],[363,918],[362,918]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/NB.png',
    width: 1080,
    height: 1080,
    latRange: [49.081062, 43.500752],
    lngRange: [-70.576172, -62.435303]
  }),

  'Newfoundland and Labrador': ensureImageMetrics({
    abbrev: 'NL',
    polygon: [[[611,877],[587,888],[571,902],[547,910],[528,925],[515,927],[507,913],[509,892],[495,894],[487,886],[472,900],[461,913],[454,932],[451,945],[467,952],[472,972],[489,1001],[494,1024],[498,1034],[515,1031],[494,1035],[488,1032],[458,1031],[434,1032],[414,1032],[419,1048],[428,1068],[431,1079],[413,1074],[404,1080],[416,1096],[435,1090],[445,1095],[449,1101],[455,1101],[455,1095],[450,1089],[465,1085],[478,1078],[475,1069],[469,1060],[474,1053],[469,1047],[475,1043],[487,1040],[501,1044],[500,1034],[514,1031],[526,1026],[538,1011],[536,995],[550,992],[547,972],[546,957],[552,945],[561,936],[570,932],[613,880],[616,875],[613,877]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/NL.png',
    width: 1188,
    height: 1188,
    latRange: [62.144976, 38.959409],
    lngRange: [-79.101563, -44.428711]
  }),
  'Northwest Territories': ensureImageMetrics({
    abbrev: 'NT',
    polygon: [    [[941,521],[766,484],[782,434],[767,436],[779,401],[756,392],[732,400],[710,416],[683,432],[674,452],[659,459],[646,496],[637,517],[593,509],[558,505],[582, 406],[625,295],[639,293],[647,297],[652,278],[671,280],[685,272],[701,276],[714,279],[737,275],[749,276],[762,285],[770,285],[773,282],[787,292],[799,277],[817,285],[829,299],[836,317],[828,327],[825,339],[819,353],[811,355],[825,369],[819,369],[803,367],[793,372],[804,380],[803,385],[793,384],[789,385],[791,397],[781,404],[772,430],[780,433],[780,469],[785,459],[795,437],[803,433],[805,453],[812,440],[826,440],[831,433],[821,426],[820,405],[831,401],[846,394],[867,420],[880,430],[881,441],[874,451],[865,452],[866,464],[850,470],[838,471],[830,468],[833,482],[826,485],[817,487],[826,497],[862,504],[862,489],[866,489],[876,481],[884,474],[888,484],[891,480],[893,469],[897,467],[903,482],[908,476],[904,473],[904,461],[911,453],[920,467],[928,481],[929,487],[925,495],[911,479],[905,483],[908,491],[898,499],[891,510],[918,515],[923,508],[930,508],[939,512],[942,519]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/NT.png',
    width: 1188,
    height: 1188,
    latRange: [77.841848, 49.553726],
    lngRange: [-150.556641, -66.708984]
  }),
  'Nova Scotia': ensureImageMetrics({
    abbrev: 'NS',
    polygon: [    [[391,1022],[369,1018],[354,1014],[358,1001],[348,987],[345,996],[339,993],[332,984],[310,970],[297,972],[293,979],[295,988],[315,998],[324,997],[326,1004],[335,1017],[346,1025],[353,1030],[361,1028],[366,1032],[374,1040],[381,1033],[379,1030],[386,1026],[394,1027],[394,1022]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/NS.png',
    width: 1116,
    height: 1024,
    latRange: [48.283193, 42.065607],
    lngRange: [-67.873535, -58.282471]
  }),

  'Ontario': ensureImageMetrics({
    abbrev: 'ON',
    polygon: [    [[488,641],[443,606],[405,570],[379,565],[332,563],[342,565],[333,570],[324,581],[320,599],[314,612],[311,627],[309,637],[325,646],[328,653],[328,667],[325,681],[313,689],[311,702],[298,707],[284,713],[277,725],[279,747],[276,767],[264,772],[262,778],[255,776],[251,769],[252,761],[242,754],[233,754],[223,757],[223,749],[216,746],[209,745],[206,739],[199,736],[200,744],[206,752],[211,765],[214,770],[219,779],[224,793],[228,790],[228,793],[230,784],[235,783],[239,787],[242,794],[251,816],[259,832],[285,850],[293,846],[293,839],[286,831],[290,817],[296,801],[293,792],[299,785],[322,775],[355,769],[383,766],[392,760],[391,752],[396,746],[405,737],[411,732],[418,726],[428,723],[443,720],[461,719],[461,686],[470,671],[471,664],[489,644]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/ON.png',
    width: 1368,
    height: 1536,
    latRange: [59.377988, 36.208823],
    lngRange: [-101.557617, -66.489258]
  }),

  'Prince Edward Island': ensureImageMetrics({
    abbrev: 'PE',

    polygon: [[[366,981],[362,993],[371,1008],[358,1008],[352,1008],[349,995],[352,984],[363,974],[372,978],[367,981]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/PEI.png',
    width: 1224,
    height: 1536,
    latRange: [47.643186, 44.785734],
    lngRange: [-65.137939, -61.358643]
  }),

  'Quebec': ensureImageMetrics({
    abbrev: 'QC',
    polygon: [    [[619,743],[616,762],[620,775],[626,783],[616,795],[601,811],[607,824],[589,830],[571,845],[567,867],[585,878],[607,871],[614,875],[597,882],[580,891],[570,899],[564,908],[541,909],[528,926],[517,929],[510,924],[507,906],[510,894],[495,891],[478,891],[471,902],[457,921],[452,937],[454,947],[472,968],[485,991],[495,1012],[495,1024],[488,1025],[482,1014],[458,1007],[451,1001],[437,978],[425,945],[418,929],[409,924],[395,924],[385,914],[367,901],[345,896],[365,909],[379,921],[394,934],[404,952],[421,955],[424,962],[424,977],[420,996],[415,987],[415,974],[418,966],[419,954],[408,952],[402,964],[392,966],[383,963],[383,957],[378,946],[375,935],[366,925],[358,919],[349,914],[342,909],[322,907],[309,905],[300,897],[290,892],[280,845],[291,852],[294,844],[283,832],[289,819],[295,801],[298,788],[304,781],[334,772],[390,762],[406,770],[417,770],[436,761],[454,752],[464,764],[482,773],[501,778],[516,774],[527,770],[540,750],[556,754],[581,749],[581,742],[595,744],[607,740],[617,743]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/QC.png',
    width: 1224,
    height: 1584,
    latRange: [65.403445, 32.842674],
    lngRange: [-87.099609, -46.142578]
  }),
  'Saskatchewan': ensureImageMetrics({
    abbrev: 'SK',
    polygon: [    [[577,426],[567,468],[560,505],[509,497],[470,492],[383,486],[339,485],[351,424],[363,369],[488,401],[577,426]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/SK.png',
    width: 1188,
    height: 1656,
    latRange: [62.226996, 45.583290],
    lngRange: [-116.455078, -94.218750]
  }),

  'Yukon': ensureImageMetrics({
    abbrev: 'YT',
    polygon: [    [[861,282],[815,244],[765,198],[720,160],[711,172],[703,171],[666,225],[646,259],[627,296],[647,295],[654,278],[667,278],[693,269],[703,273],[710,279],[720,279],[749,272],[755,285],[776,283],[789,288],[801,274],[829,297],[844,290],[859,287],[862,282]]],
    color: '#ff8c0078',
    fillColor: 'gold',
    fillOpacity: 0.1,
    mapUrl: '/images/maps/YT.png',
    width: 1296,
    height: 1656,
    latRange: [71.286699, 57.064630],
    lngRange: [-147.656250, -121.552734]
  }),

};


document.addEventListener('DOMContentLoaded', function() {
  parks = window.ALL_PARKS || [];

  // Group parks by province
  parksByProvince = {};
  for (const park of parks) {
    const prov = park.province || 'Unknown';
    if (!parksByProvince[prov]) parksByProvince[prov] = [];
    parksByProvince[prov].push(park);
  }

  initCanadaView();
});


////// CANADA VIEW
function initCanadaView(animated = true) {
  selectedProvince = null;

  if (map) map.remove();
  if (backControl) { backControl.remove(); backControl = null; }

  map = L.map('all-parks-map', {
    crs: L.CRS.Simple,
    minZoom: -1,
    zoomControl: false,
  });

  // (center near middle of Canada image)
  map.setView([canadaData.height / 2, canadaData.width / 2], 0);

  currentOverlay = L.imageOverlay(canadaData.imageUrl, canadaData.bounds).addTo(map);
 
  // Smooth transition
  map.flyToBounds(canadaData.bounds, {
    animate: true,
    duration: 1.0,      // seconds
    easeLinearity: 0.25,
    padding: [1, 1]
  });


  // Dynamic min/max zoom + pan lock
  setMapViewLimits(map, canadaData.bounds, canadaData.width, canadaData.height, MAP_DEFAULTS);

  // Province list
  const provinceUl = document.querySelector('#province-list ul');
  if (provinceUl) {
    provinceUl.innerHTML = '';

    // Add province polygons (pixel space over Canada image)
    for (const [provinceName, provinceData] of Object.entries(provinceList)) {
      if (!parksByProvince[provinceName] || parksByProvince[provinceName].length === 0) continue;

      const li = document.createElement('li');
      li.textContent = provinceName;
      li.dataset.abbrev = provinceData.abbrev;
      li.addEventListener('click', () => selectProvince(provinceData));
      provinceUl.appendChild(li);

      const polygonLayer = L.polygon(provinceData.polygon, {
        color: provinceData.color,
        fillColor: provinceData.fillColor,
        fillOpacity: provinceData.fillOpacity,
      }).addTo(map);

      provinceData.layer = polygonLayer;

      
      // CLICK — load province & set persistent highlight
      polygonLayer.on('click', () => {
        selectProvince(provinceData);
      });

      // HOVER — temporary highlight
      polygonLayer.on('mouseover', () => {
        if (activeProvinceLayer !== polygonLayer) highlight(polygonLayer);
      });
      polygonLayer.on('mouseout', () => {
        if (activeProvinceLayer !== polygonLayer) resetHighlight(polygonLayer);
      });

      // polygonLayer.on('click', () => selectProvince(provinceData));
      // polygonLayer.on('mouseover', () => highlight(polygonLayer));
      // polygonLayer.on('mouseout', () => resetHighlight(polygonLayer));

      li.addEventListener('click', () => {
        setActiveProvince(provinceData, li);
        selectProvince(provinceData);
      });


      // Hover list → polygon glow
      li.addEventListener('mouseover', () => {
        if (activeProvinceLayer !== polygonLayer) highlight(polygonLayer);
      });
      li.addEventListener('mouseout', () => {
        if (activeProvinceLayer !== polygonLayer) resetHighlight(polygonLayer);
      });
    }
  }

  // Debug coordinate picker button (remove in prod)
  // const debugBtn = L.control({ position: 'topright' });
  // debugBtn.onAdd = function() {
  //   const div = L.DomUtil.create('div', 'debug-coords-btn');
  //   div.innerHTML = '📍 Debug: Trace Province';
  //   div.style.background = 'white';
  //   div.style.padding = '4px 8px';
  //   div.style.marginTop = '5px';
  //   div.style.borderRadius = '4px';
  //   div.style.cursor = 'pointer';
  //   div.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
  //   div.onclick = enableDebugClickMode;
  //   return div;
  // };
  // debugBtn.addTo(map);

  // Clear park list
  document.getElementById('park-list').innerHTML = '';


  // Smooth when going back to Canada view
  if (animated) {
    map.flyToBounds(canadaData.bounds, { animate: true, duration: 1, padding: [1, 1] });
  } else {
    map.fitBounds(canadaData.bounds);
  }


}

////////// POPULATE PARK LIST
function populateParkList(provinceName) {
  const parkUl = document.querySelector('#park-list');
  if (!parkUl) return;

  parkUl.innerHTML = '';

  const parksInProvince = parksByProvince[provinceName] || [];
  if (parksInProvince.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No parks available';
    parkUl.appendChild(p);
    return;
  } 

  parksInProvince.forEach(park => {
    const div = document.createElement('div');
    div.classList.add('park-result-div')

    const a = document.createElement('a')
    a.href = `/camp${park.slug}`

    const img = document.createElement('img')
    img.src = park?.image || '/images/icons/not-found.jpg'

    const parkName = document.createElement('div')
    parkName.textContent = park.name;

    const parkProvince = document.createElement('div')
    parkProvince.setAttribute('style', 'font-size: var(--font-extra-extra-small); font-weight: normal;')
    parkProvince.textContent = park.province;

    // HOVER to highlight marker
    div.addEventListener('mouseover', () => {
      const m = parkIdToMarker[park._id];
      if (!m) return;
      m.setIcon(parkIconHighlight);
    });

    // Undo hover
    div.addEventListener('mouseout', () => {
      const m = parkIdToMarker[park._id];
      if (!m) return;
      m.setIcon(parkIcon);
    });


    // // Undo hover
    // div.addEventListener('mouseout', () => {
    //   const m = parkIdToMarker[park._id];
    //   if (!m) return;
    //   m.setIcon(new L.Icon.Default());
    // });

    div.appendChild(a)
    a.appendChild(img)
    a.appendChild(parkName)
    a.appendChild(parkProvince)
    parkUl.appendChild(div);
  });

}


// HOVER HIGHLIGHT HELPERS
function highlight(layer) { layer.setStyle({ fillOpacity: 0.7 }); }
function resetHighlight(layer) { layer.setStyle({ fillOpacity: 0.1 }); }


// // LAT/LNG → IMAGE COORDS (province view)
// function latLngToImageCoords(lat, lng, province) {
//   const bounds = province.bounds;
//   const topLeft = bounds[0];
//   const bottomRight = bounds[1];

//   const latRange = province.latRange;
//   const lngRange = province.lngRange;

//   const y = ((latRange[1] - lat) / (latRange[1] - latRange[0])) * (bottomRight[0] - topLeft[0]);
//   const x = ((lng - lngRange[0]) / (lngRange[1] - lngRange[0])) * (bottomRight[1] - topLeft[1]);

//   return [y, x];
// }

// DYNAMIC ZOOM + PAN LIMITS
function setMapViewLimits(map, imageBounds, imageWidth, imageHeight, options = {}) {
  const { bufferZoom = 0.2, maxZoomExtra = 1, panBuffer = 20 } = options;

  const containerSize = map.getSize();
  const zoomX = Math.log2(containerSize.x / imageWidth);
  const zoomY = Math.log2(containerSize.y / imageHeight);
  const fitZoom = Math.min(zoomX, zoomY);

  const minZoom = fitZoom - bufferZoom;
  const maxZoom = fitZoom + maxZoomExtra;

  map.setMinZoom(minZoom);
  map.setMaxZoom(maxZoom);

  const [[y0, x0], [y1, x1]] = imageBounds;
  const paddedBounds = L.latLngBounds(
    [y0 - panBuffer, x0 - panBuffer],
    [y1 + panBuffer, x1 + panBuffer]
  );
  map.setMaxBounds(paddedBounds);
  map.options.maxBoundsViscosity = 0.9;
}

/* Recalculate zoom/pan limits if the window resizes */
window.addEventListener('resize', () => {
  if (map && currentOverlay) {
    const b = currentOverlay._bounds; // Leaflet LatLngBounds
    const width  = b.getEast();
    const height = b.getSouth();

    // Convert to nested array like the rest of your code expects
    const arrayBounds = [
      [b.getSouthWest().lat, b.getSouthWest().lng],
      [b.getNorthEast().lat, b.getNorthEast().lng]
    ];

    setMapViewLimits(map, arrayBounds, width, height, MAP_DEFAULTS);

    map.invalidateSize();

    map.flyToBounds(arrayBounds, { animate: true, duration: 0.6, padding: [1, 1] });

  }
});



// DEBUG HELPER: CLICK TO TRACE PIXEL POLYGONS
let debugMode = false;
let debugPoints = [];
let debugLayer = null;

function enableDebugClickMode() {
  if (!map) return;

  debugMode = true;
  debugPoints = [];

  alert('Debug mode ON. Click to add polygon points.\nRight-click (or long-press) to finish.');

  if (debugLayer) {
    map.removeLayer(debugLayer);
    debugLayer = null;
  }

  map.on('click', handleMapClick);
  map.on('contextmenu', finishDebugPolygon); // right-click or two-finger tap
}

function handleMapClick(e) {
  if (!debugMode) return;

  // In L.CRS.Simple, lat/lng are just pixel Y/X of the image space
  const coord = [e.latlng.lat, e.latlng.lng];
  debugPoints.push(coord);
  console.log('Point:', `[${coord[0].toFixed(0)}, ${coord[1].toFixed(0)}],`);

  if (debugLayer) map.removeLayer(debugLayer);
  debugLayer = L.polygon(debugPoints, { color: 'red', weight: 2 }).addTo(map);
}

function finishDebugPolygon() {
  if (!debugMode) return;

  debugMode = false;
  map.off('click', handleMapClick);
  map.off('contextmenu', finishDebugPolygon);

  const rounded = debugPoints.map(p => [Math.round(p[0]), Math.round(p[1])]);
  console.log('%cFinal Polygon Coordinates:', 'color: lime; font-weight: bold;');
  console.log(JSON.stringify(rounded));

  alert(' Polygon complete! Coordinates logged to console.');
}

/* ======================
   FUNC TO SET ACTIVE PROVINCE (I.E., when selected)
   ====================== */
function setActiveProvince(provinceData, liElement = null) {
  const canadaLi = document.querySelector('#province-list li[data-abbrev="CANADA"]');
  if (canadaLi) canadaLi.classList.remove('selected-province');

  // Reset old highlight
  if (activeProvinceLayer) {
    activeProvinceLayer.setStyle({ fillOpacity: 0.1, weight: 2 });
  }
  if (activeProvinceLi) {
    activeProvinceLi.classList.remove('selected-province');
  }

  // Set new highlight
  activeProvinceLayer = provinceData.layer;
  activeProvinceLayer.setStyle({ fillOpacity: 0.75, weight: 3 });

  activeProvinceLi = liElement || document.querySelector(
    `#province-list li[data-abbrev="${provinceData.abbrev}"]`
  );
  if (activeProvinceLi) activeProvinceLi.classList.add('selected-province');
}


function clearActiveProvinceHighlight() {
  if (activeProvinceLayer) {
    activeProvinceLayer.setStyle({ fillOpacity: 0.1, weight: 2 });
    activeProvinceLayer = null;
  }
  if (activeProvinceLi) {
    activeProvinceLi.classList.remove('selected-province');
    activeProvinceLi = null;
  }

  // Also unhighlight Canada (if we’re switching away)
  const canadaLi = document.querySelector('#province-list li[data-abbrev="CANADA"]');
  if (canadaLi) {
    canadaLi.classList.remove('selected-province');
  }
}


function selectProvince(provinceData) {
  const provinceName = Object.keys(provinceList)
      .find(k => provinceList[k].abbrev === provinceData.abbrev);

  // highlight active province
  setActiveProvince(provinceData);

  // populate park list
  populateParkList(provinceName);

  // scroll to park list
  document.getElementById("park-list")
      .scrollIntoView({ behavior: "smooth", block: "start" });

  // Push login event to Google Tag Manager (GTM)).
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'province_select',
    province_selected: provinceName,
    page_location: window.location.href 
  });
}
