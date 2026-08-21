import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
// Add footer date

let map;
let points = null; // Global variable to store points (needed for the OD network)

// --- OD (origin-destination) mobility network state ---
// Ported from Participant_ODNetwork_MobilityMode.html once that page's design was approved.
let directionsService; // Instantiated in markGoogleMapsReady(), once the Google Maps SDK has actually loaded
let allRoutes = []; // Every straight-line + routed polyline, with participant/type/endpoint metadata
let routeLayers = {}; // Store polylines per participant
let allMarkers = []; // Store { marker, participantId } for every point, for dim/isolate
let allGroupedRoutes = {}; // participantId -> points[], set once in setupODNetwork, read
// later to compute the bounding-box rectangle for whichever network is isolated
let networkBoundingBox = null; // the currently-drawn rectangle layer, if any
let boundingBoxParticipantId = null; // who it's currently drawn for, to avoid rebuilding needlessly
// Set when a line or a point is clicked while its own participant is already the
// isolated one: clicking a line highlights it plus its straight/routed counterpart;
// clicking a point highlights every line touching it (of any count) plus the point
// itself. Both share this same pair of lists so highlightParticipantRoutes() only
// needs one code path. Cleared by clicking a different line/point or changing the
// dropdown selection.
let highlightedLines = []; // allRoutes entries currently orange-highlighted
let highlightedMarkerPoints = []; // point objects currently orange-highlighted
// 'line' or 'point', matching whichever kind of click set the two lists above - only
// that entity type gets its tooltip forced open (a point click colors its lines
// orange too, but their tooltips stay off; only the clicked point's tooltip shows).
let highlightTriggerType = null;

// Resolved once the Google Maps SDK has actually loaded - the routed (Google Directions)
// half of the network waits on this instead of racing the SDK's own async load, since
// map.js's own getLocalData()-driven startup runs independently of it. index.html defines
// window.initMap as a tiny synchronous inline stub (before the Google script tag) that
// just dispatches the 'google-maps-ready' event, so this works regardless of whether the
// Google script (async) or this module (deferred) finishes loading first: if the event
// already fired before this line runs, window.google.maps is already present and we
// resolve immediately; otherwise we wait for the event.
let googleMapsReadyResolve;
const googleMapsReady = new Promise((resolve) => { googleMapsReadyResolve = resolve; });
function markGoogleMapsReady() {
    directionsService = new google.maps.DirectionsService();
    googleMapsReadyResolve();
}
if (window.google && window.google.maps) {
    markGoogleMapsReady();
} else {
    window.addEventListener('google-maps-ready', markGoogleMapsReady, { once: true });
}

const participantColors = [
    "#66C5CC", "#F6CF71", "#F89C74", "#DCB0F2", "#87C55F",
    "#9EB9F3", "#FE88B1", "#C9DB74", "#8BE0A4", "#B497E7",
    "#D3B484", "#B3B3B3"
];
// Participant IDs are "P1".."P10" - map each to one color, in order, wrapping
// around past 10 rather than erroring if more participants are added later.
function getParticipantColor(participantId) {
    const n = parseInt(participantId.replace(/\D/g, ''), 10);
    const index = (Number.isFinite(n) ? n - 1 : 0) % participantColors.length;
    return participantColors[index];
}

function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0;
    const d = max - min;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return h;
}

// The bright highlight color for a network's clicked line/point: the same hue as the
// participant's assigned pastel color, pushed to a fixed vivid saturation/lightness
// instead of the pastel's own soft values - reads as "an intense version of this
// participant's color", not an unrelated hue shared by everyone.
function getHighlightColor(participantId) {
    const hue = hexToHsl(getParticipantColor(participantId));
    return `hsl(${hue.toFixed(1)}, 90%, 50%)`;
}

const modeColors = {
    'driving': 'white',
    'walking': 'grey',
    'MARTA': 'orange',
    'transit': 'orange',
    'str_line': 'black'
};

// Google's TravelMode enum only exists once the SDK has loaded, so this stays plain
// strings and gets resolved via google.maps.TravelMode[...] inside fetchGoogleDirections
// (only called after googleMapsReady resolves) rather than referencing `google` here.
const googleTravelModeMap = { driving: 'DRIVING', walking: 'WALKING', MARTA: 'TRANSIT' };

const routedParticipants = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

// Shape encodes *what kind of place* a point is (its `description`), while color
// encodes *which participant* it belongs to - two independent categorical variables.
const descriptionShapes = {
    'Community Engagement': 'src/assets/participant_points_shape_icons/circle.svg',
    'Education': 'src/assets/participant_points_shape_icons/flare.svg',
    'Family': 'src/assets/participant_points_shape_icons/hexagon.svg',
    'Grocery': 'src/assets/participant_points_shape_icons/pentagon.svg',
    'Health': 'src/assets/participant_points_shape_icons/rhombus.svg',
    'Recreation': 'src/assets/participant_points_shape_icons/square.svg',
    'Religious': 'src/assets/participant_points_shape_icons/triangle.svg',
    'Social': 'src/assets/participant_points_shape_icons/star.svg',
    'Workplace': 'src/assets/participant_points_shape_icons/octagon.svg',
    'Home': 'src/assets/participant_points_shape_icons/house.svg'
};

// The source SVGs are solid single-color shapes (fill baked into the file), so rather
// than swapping files per color, each icon is used as a CSS mask over a div painted in
// the participant's actual color - an exact color match instead of a CSS-filter guess.
function coloredShapeIcon(shapeUrl, color) {
    const maskCss = `url('${shapeUrl}') center / contain no-repeat`;
    return L.divIcon({
        className: 'participant-marker',
        html: `<div style="width:24px;height:24px;background-color:${color};` +
            `-webkit-mask:${maskCss};mask:${maskCss};"></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
}

// Home points get the same masked house shape, plus a soft glowing ring behind it (a
// larger, blurred, semi-transparent circle in the participant's own color) so they read
// as visually distinct from every other point at a glance.
function coloredHomeIcon(shapeUrl, color) {
    const maskCss = `url('${shapeUrl}') center / contain no-repeat`;
    return L.divIcon({
        className: 'participant-marker home-marker',
        html: `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;` +
            `border-radius:50%;background:${color};opacity:0.35;filter:blur(3px);` +
            `position:absolute;top:0;left:0;"></div>` +
            `<div style="width:36px;height:36px;background-color:${color};position:relative;` +
            `margin:2px;-webkit-mask:${maskCss};mask:${maskCss};"></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });
}

// Icons for whichever points are highlighted (line-pair endpoints, or a clicked point) -
// cached by "description|participantId" since the highlight color is per-participant.
const highlightIconCache = {};
function getHighlightIcon(description, participantId) {
    const cacheKey = `${description}|${participantId}`;
    if (!highlightIconCache[cacheKey]) {
        const shapeUrl = descriptionShapes[description];
        const color = getHighlightColor(participantId);
        highlightIconCache[cacheKey] = description === 'Home'
            ? coloredHomeIcon(shapeUrl, color)
            : coloredShapeIcon(shapeUrl, color);
    }
    return highlightIconCache[cacheKey];
}

// basically recreating URL with variables
const a = {
    data: {},
    domain: {
        unit: "block%20group",
        state: ['13'], // ["*"],
        // The 11-county Atlanta region: Cherokee, Clayton, Cobb, DeKalb, Douglas, Fayette,
        // Forsyth, Fulton, Gwinnett, Henry, Rockdale.
        county: ['057', '063', '067', '089', '097', '113', '117', '121', '135', '151', '247'],
        // Fulton and DeKalb are the core study area; every other county is drawn desaturated.
        coreCounties: ['089', '121'],
        tract: ["*"],
        block_group: ["*"],
        data: "2019/acs/acs5",
    },
    censusKey: "e7eab780ec5da249e8f292708c77527582e04218",
    variables: [{
        name: "totalPopulation",
        label: "Total Population",
        var: "B02001_001E",
    },
    {
        name: "blackPopulation",
        label: "Black Population",
        var: "B02001_003E",
    },
    {
        name: "whitePopulation",
        label: "White Population",
        var: "B02001_002E",
    },

    ],
    vars: {
        totalV: "totalPopulation",
        blackV: "blackPopulation",
        whiteV: "whitePopulation"
    },
    // Neighborhood racial classification: whichever group holds a >=50% majority.
    // "Other" = every race category besides White and Black alone (American Indian/Alaska
    // Native, Asian, Native Hawaiian/Pacific Islander, some other race, two or more races) -
    // these sum to (Total - White - Black) since B02001's categories are mutually exclusive.
    raceColors: {
        White: "#2B92A0",
        Other: "#99B60C",
        "Racially Mixed": "#5C5A58",
        Black: "#BB0069"
    },
    // Shared with the rest-of-Georgia backdrop fill, so both always match.
    countyOutlineColor: "#1a1f2e",
    // Shared "faded/non-focus" fill opacity - used for non-core counties within the region
    // AND for the rest-of-Georgia backdrop, so both stay at the same visual intensity.
    nonCoreFillOpacity: 0.35,
    geojson: {
        counties: "data/atlantaRegionBG.json",
        restOfGeorgia: "data/restOfGeorgiaCounties.geojson",
    },
};
// Set global variables for header, map container, and footer
const header = document.querySelector("header");
const mapContainer = document.querySelector("#map");
const footer = document.querySelector("footer");
const locate = document.querySelector("#geolocate-ui");

// Call the main functions to test local storage and setup the map
testLocalStorage()

// Check for localStorage
function testLocalStorage() {
    // try to write and remove an item
    try {
        localStorage.setItem('test', 'test');
        localStorage.removeItem('test');
        console.log(localStorage);
        setLocalStorage()
    } catch (e) {
        console.log('Local storage not available:', e);
        // Will need to fork the code to handle this case :(
    }
}

// Check for localStorage and set up caching
function setLocalStorage() {
    // If our app data is not in localStorage, clear local storage.
    // This is a way to clear out old data while we develop the app.
    if (!localStorage.getItem("myApp")) {
        localStorage.clear();
    } else {
        // If we do have the app data, check if it is expired.
        // If it's older than 6 minutes, clear it.
        const myApp = JSON.parse(localStorage.getItem("myApp"));
        if (checkExpired(myApp.timestamp, 0.1)) {
            localStorage.clear();
        }
    }
    // Create an object to store in localStorage.
    const data = {
        info: "Storing information in localStorage",
    }
    // Store the data in localStorage, which will add a timestamp.
    try {
        storeData("myApp", data);
    } catch (e) {
        console.warn('Failed to setup storage:', e);
        // Hmm... what to do here?
    }
}

// Check for expiration of data in localStorage
// using timestamp od stored data and desired duration in hours
function checkExpired(timestamp, hours) {
    const duration = hours * (60 * 60 * 1000); // set duration in hours
    // Milliseconds since 1970 (when rock n roll really started)
    const now = Date.now();
    // Check if data is older than duration
    if (now - timestamp > duration) {
        return true; // Data is expired
    } else {
        return false; // Data is still fresh
    }
}
// Retrieve data from localStorage using key and check for expiration
function retrieveData(key) {
    const cached = localStorage.getItem(key);
    // If no data, return null. End function.
    if (!cached) return null;

    // Destructure properties to new variables
    const { timestamp, data } = JSON.parse(cached);

    // Check if data is expired, e.g., older than 6 minutes
    if (checkExpired(timestamp, 0.1)) {
        // Remove expired data from localStorage
        // which will force a refetch next time.
        localStorage.removeItem(key);
    }
    // Return the data to where function is called
    return data;
}
// Store data in localStorage with key name
function storeData(key, data) {
    // Build an object with timestamp and data
    const cacheObject = {
        timestamp: Date.now(),
        data: data
    };
    // Store the object in localStorage with try/catch
    try {
        localStorage.setItem(key, JSON.stringify(cacheObject));
    } catch (e) {
        console.warn('Failed to cache data:', e);
        // Hmm... what to do here?
        // Over time, localStorage can fill up.
        // Maybe clear and refetch?
    }
}
// Fetch GeoJSON data with caching
// using a key and URL
async function fetchJSON(key, url) {
    // try/catch block to handle errors
    try {
        // Check cache first
        const cachedData = retrieveData(key);
        // If cachedData not null...
        if (cachedData) {
            console.log('Using cached data');
            return cachedData;
        }
        // Fetch fresh data if no cache
        console.log('Fetching fresh data');
        // await for fetch to resolve and parse JSON
        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok, dig?');
        const data = await response.json();

        // Store the data in localStorage
        storeData(key, data);

        // Return the data to where function is called
        return data;
    } catch (error) {
        console.error('Error fetching data:', error);
        // Hmm... what to do here?
        throw error;
    }
}

async function getLocalData() {
    try {
        points = await d3.json("data/ParticipantPointsMerged.geojson");

        const places = await d3.json("data/gaPlaces.geojson");
        const roads = await d3.json("data/atlRoadsHoe.geojson");
        const countyBoundaries = await d3.json("data/atlantaCounties.geojson");
        const restOfGeorgia = await d3.json(a.geojson.restOfGeorgia);
        const h3Racial = await d3.json("data/FD_H3_racialP.geojson");

        return { points, places, roads, countyBoundaries, restOfGeorgia, h3Racial };
    } catch (error) {
        console.error("ERROR!", error);
        return null;
    }
}




async function setupMap(points, places, roads, countyBoundaries) {
    // Default center = the geographic center of the core counties' (Fulton/DeKalb) combined
    // bounds, not a hand-picked coordinate - keeps the initial view honestly centered on the
    // actual study area regardless of how the county geometry itself changes over time.
    let defaultCenter = [33.748997, -84.387985]; // fallback if county geometry isn't available
    if (countyBoundaries && countyBoundaries.features) {
        const coreFeatures = countyBoundaries.features.filter(
            (f) => a.domain.coreCounties.includes(f.properties.COUNTYFP)
        );
        if (coreFeatures.length) {
            const coreCenter = L.geoJSON({ type: 'FeatureCollection', features: coreFeatures })
                .getBounds()
                .getCenter();
            defaultCenter = [coreCenter.lat, coreCenter.lng];
        }
    }

    let options = {
        center: defaultCenter,
        zoom: 13,
        scrollWheelZoom: false
    };

    // Retrieve cached map options
    if (retrieveData('mapOptions')) {
        console.log('Using cached map options');
        options = retrieveData('mapOptions');
    }

    // Initialize the map and assign it to the global variable `map`
    // No tile layer - the map runs without a basemap image (the #map container's own dark
    // CSS background stands in for one), since with demographics/counties/network layers
    // all on at once a basemap underneath is one layer too many.
    map = L.map('map').setView(options.center, options.zoom);

    // #network-controls and #legend are nested inside #map itself (so they can be
    // positioned relative to it) rather than living outside it - Leaflet listens for
    // mouse/scroll events on the whole container, so without these guards, clicking the
    // dropdown or scrolling the legend would also drag/zoom the map underneath.
    ['network-controls', 'legend'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
        }
    });

    // Store map options in localStorage when map pans or zooms
    map.on('moveend', function () {
        const data = {
            center: map.getCenter(),
            zoom: map.getZoom()
        };
        storeData('mapOptions', data);
    });

    console.log("Map initialized:", map);
    return map;
}

// Define the function to get the census data.
async function getCensus() {
    // Create an empty GeoJSON to hold the features
    const acsData = {
        "type": "FeatureCollection",
        "name": "Urban Atlanta Counties",
        "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },
        "features": []
    };
    // map method returns new array of variables
    // by looping through a.variables array and returning the var property.
    // join method convert the array into a string with items separated by commas.
    const variables = a.variables.map((v) => v.var).join(",");
    // Create the URL for the Census API.
    const url = `https://api.census.gov/data/${a.domain.data}?get=NAME,${variables}&for=${a.domain.unit}:*&in=state:${a.domain.state}&in=county:${a.domain.county}&in=tract:${a.domain.tract}&key=${a.censusKey}`;
    const urlDekalb = `https://api.census.gov/data/${a.domain.data}?get=NAME,${variables}&for=${a.domain.unit}:*&in=state:${a.domain.state}`;
    //console.log(url); //looks good

    // Create an array of promises from two fetch requests.
    // The first fetch request gets the census data and assigns it to the variable censusResponse.
    // The second fetch request gets the county geometry data and assigns it to the variable geometryResponse.
    const [censusResponse, geometryResponse] = await Promise.all([
        fetch(url).then((r) => r.json()),
        fetch(a.geojson.counties).then((r) => r.json()),
    ]);
    // The function will pause here until all promises are resolved.

    // Make shorthand variable names.
    // Remove header row (index value 0) from the census data (an array of arrays).
    // slice method starts at second item and selects to the end of the array.
    const censusData = censusResponse.slice(1);
    const countyGeom = geometryResponse;

    //console.log(countyGeom); //TRACTCE: 010304 & GEOID: 131210103041...no ready join field
    //need to create join field
    // Include COUNTYFP in the join key - tract numbers are only unique *within* a county,
    // so with 11 counties in play, two different counties can share the same tract number.
    countyGeom.features.forEach((feature) => {

        feature.properties.joinField = feature.properties.COUNTYFP + feature.properties.TRACTCE + feature.properties.BLKGRPCE;
    });

    // Loop through the census data.
    for (const census of censusData) {
        // Slice off last three elements (county, tract, block group) and concatenate.
        // The -4..-1 elements are [state, county, tract, block group]; we skip state
        // since it's constant here and not part of the geometry's joinField.
        const countyFips = census.slice(-3).join("");
        //console.log(countyFips); //county+tract+block group

        // Find the geometry that matches the countyFips via GEOID.
        // find method returns the first element in array that matches the condition
        // and returns the entire object.
        const match = countyGeom.features.find(g => g.properties.joinField === countyFips);

        // If there is a match, add the census data to it.
        if (match) {
            //console.log(match); //looks good
            // Create a new object in the properties object of the match object.
            match.properties.census = {};

            // Loop through the a.variables array.
            // Use the name property and index to assign the census data.
            // Builds an object with the name property as the key and the census data as the value.
            a.variables.forEach(({ name }, i) => {
                // console.log(name, i, census[i], census[i + 1]);
                // Offset by 1 because the first element is the county name.
                match.properties.census[name] = census[i + 1];
            });

            // Add the match object to the acsData object.
            // This will contain all counties with census data.
            //acsData.features.push(match);
            acsData.features.push(JSON.parse(JSON.stringify(match)));
        }
    }
    console.log('json', acsData);
    return acsData;
}// end getCensus

getLocalData().then((dataUpload) => {
    if (!dataUpload) {
        console.error("Failed to load local data. Check file paths or JSON syntax.");
        return;
    }

    let { points, places, roads, countyBoundaries, restOfGeorgia, h3Racial } = dataUpload;
    points = dataUpload.points; // Global access to points

    console.log(points.features);
    if (!points || !points.features) {
        console.error("Points data is missing or invalid.");
        return;
    }

    // Wait for the map to be ready before calling nextContent
    setupMap(points, places, roads, countyBoundaries).then((initializedMap) => {
        map = initializedMap;  // Ensure map is assigned globally
        getCensus().then((acsData) => {
            drawMap(points, places, roads, map, acsData, countyBoundaries, restOfGeorgia, h3Racial);
            setupEventListeners(map);
        }).catch(error => {
            console.error("Failed to fetch census data, drawing map without demographics layer:", error);
            drawMap(points, places, roads, map, null, countyBoundaries, restOfGeorgia, h3Racial);
            setupEventListeners(map);
        });
    }).catch(error => {
        console.error("Failed to set up the map:", error);
    });
});

// Classify a block group by racial majority (>=50% threshold).
// Returns "White", "Black", "Other", "Racially Mixed", or null if the block group
// has no recorded population (majority is undefined for zero residents).
function classifyRace(feature) {
    const census = feature.properties.census;
    const total = Number(census[a.vars.totalV]);
    if (!total) return null;

    const whiteRate = Number(census[a.vars.whiteV]) / total;
    const blackRate = Number(census[a.vars.blackV]) / total;
    const otherRate = 1 - whiteRate - blackRate;

    if (whiteRate >= 0.5) return "White";
    if (blackRate >= 0.5) return "Black";
    if (otherRate >= 0.5) return "Other";
    return "Racially Mixed";
}

// Same >=50% majority rule as classifyRace(), for the finer-grained H3 hex-grid dataset
// (FD_H3_racialP.geojson) - it ships pre-computed pct_white/pct_black/pct_other
// percentages (0-100) per point instead of raw census counts, so no total/rate division
// is needed here. Returns null (skip this point) if all three are missing/zero.
function classifyH3Point(feature) {
    const p = feature.properties;
    const white = Number(p.pct_white) || 0;
    const black = Number(p.pct_black) || 0;
    const other = Number(p.pct_other) || 0;
    if (white === 0 && black === 0 && other === 0) return null;

    if (white >= 50) return "White";
    if (black >= 50) return "Black";
    if (other >= 50) return "Other";
    return "Racially Mixed";
}

// Appends a small hover-info icon to the top-right corner of a legend control,
// explaining the same majority-classification rule classifyRace() implements.
// Reusable by any layer control built on this classification, not just the block-group one.
function addRaceInfoIcon(container) {
    container.style.position = 'relative';
    const icon = L.DomUtil.create('span', 'race-info-icon', container);
    icon.innerHTML = 'i';
    const tooltip = L.DomUtil.create('div', 'race-info-tooltip', icon);
    tooltip.innerHTML = 'Each area is classified by whichever race holds a majority ' +
        '(&ge;50%) of its population. If no group reaches 50%, it is classified as ' +
        'Racially Mixed. "Other" combines every race besides White and Black alone ' +
        '(American Indian/Alaska Native, Asian, Native Hawaiian/Pacific Islander, ' +
        'some other race, and people reporting two or more races).';
    return icon;
}

// Display GeoJSON
function drawMap(points, places, roads, map, acsData, countyBoundaries, restOfGeorgia, h3Racial) {
    // Create custom panes with specific zIndex values
    map.createPane('restOfGeorgiaPane');
    map.getPane('restOfGeorgiaPane').style.zIndex = 100; // Beneath everything - pure backdrop

    map.createPane('suburbsPane');
    map.getPane('suburbsPane').style.zIndex = 200; // Lowest zIndex

    map.createPane('demographicsPane');
    map.getPane('demographicsPane').style.zIndex = 200;

    map.createPane('h3RacialPane');
    map.getPane('h3RacialPane').style.zIndex = 300; // Above the block-group choropleth, below counties

    map.createPane('countiesPane');
    map.getPane('countiesPane').style.zIndex = 350;

    map.createPane('atlantaPane');
    map.getPane('atlantaPane').style.zIndex = 400;

    map.createPane('networkLinesPane');
    map.getPane('networkLinesPane').style.zIndex = 500; // Mobility-network lines

    map.createPane('pointsPane');
    map.getPane('pointsPane').style.zIndex = 600; // Mobility-network points - highest zIndex

    //census data first
    let demographics = null;
    if (acsData && acsData.features && acsData.features.length) {
        demographics = L.geoJson(acsData, {
            pane: 'demographicsPane', // Assign to demographicsPane
            style: function (feature) {
                const classification = classifyRace(feature);
                if (!classification) {
                    // No recorded population - leave unfilled rather than guessing a category.
                    return { fillOpacity: 0, weight: 0, interactive: false };
                }
                const fillColor = a.raceColors[classification];
                // Fulton and DeKalb are the core study area and stay at full intensity;
                // every other county in the 11-county region is drawn greyed out (lower opacity).
                const isCoreCounty = a.domain.coreCounties.includes(feature.properties.COUNTYFP);
                return {
                    fillColor: fillColor,
                    // Wide enough to paint over the hairline anti-aliasing gaps that appear
                    // between adjacent polygons in SVG rendering - since it's the same color
                    // as the fill, it reads as solid color rather than a visible border.
                    weight: 1,
                    opacity: isCoreCounty ? 1 : a.nonCoreFillOpacity,
                    color: fillColor,
                    // Core counties: stroke fully opaque, fill slightly less so - the outer
                    // counties instead use the same value for both (no stroke/fill contrast),
                    // so Fulton/DeKalb stay clearly more solid/prominent than the rest of the region.
                    fillOpacity: isCoreCounty ? 0.7 : a.nonCoreFillOpacity,
                };
            },
            onEachFeature: function (feature, layer) {
                // Outer (non-core) counties get a single county-level popup instead
                // (bound on the county outline layer below) - no per-block-group popups there.
                const isCoreCounty = a.domain.coreCounties.includes(feature.properties.COUNTYFP);
                if (!isCoreCounty) return;

                const classification = classifyRace(feature);
                const census = feature.properties.census;
                const total = Number(census[a.vars.totalV]);
                if (!classification || !total) {
                    layer.bindTooltip(
                        `Community: ${feature.properties.TRACTCE}-${feature.properties.BLKGRPCE}: <br>
No recorded population`
                    );
                    return;
                }
                const black = Number(census[a.vars.blackV]);
                const white = Number(census[a.vars.whiteV]);
                const other = total - black - white;
                layer.bindTooltip(
                    `Community: ${feature.properties.TRACTCE}-${feature.properties.BLKGRPCE}: <br>
Classification: ${classification} <br>
white pop: ~ ${((white / total) * 100).toFixed(1)}% <br>
black pop: ~ ${((black / total) * 100).toFixed(1)}% <br>
other pop: ~ ${((other / total) * 100).toFixed(1)}%`
                );
            },
        }).addTo(map); // on by default
    } else {
        console.warn("Skipping demographics layer: no census data available.");
    }

    // Fine-grained H3 hex-grid version of the same majority-race classification as the
    // block-group choropleth above (classifyH3Point/a.raceColors - same colors, same
    // >=50% rule), just at much higher spatial resolution (8,955 points vs. block
    // groups). Only covers Fulton/DeKalb (the dataset's namesake "FD"). Off by default -
    // dense enough to want toggling on deliberately rather than always-on with everything
    // else (not .addTo(map) here; the layer control below adds it when checked).
    let h3RacialLayer = null;
    if (h3Racial && h3Racial.features && h3Racial.features.length) {
        h3RacialLayer = L.geoJson(h3Racial, {
            pane: 'h3RacialPane',
            filter: (feature) => classifyH3Point(feature) !== null,
            pointToLayer: (feature, latlng) => {
                const classification = classifyH3Point(feature);
                const color = a.raceColors[classification];
                return L.circleMarker(latlng, {
                    radius: 4,
                    color: color,
                    fillColor: color,
                    weight: 0,
                    fillOpacity: 0.85
                });
            }
        });
    }

    // Mobility (OD) network: participant points (shape = place type, color = participant,
    // Home points get a halo house icon) plus the straight-line and Google-routed
    // connections between every pair of a participant's points.
    setupODNetwork(points);

    const atlhoe = L.geoJSON(places, {
        pane: 'atlantaPane', // Assign to atlantaPane
        onEachFeature: (feature, layer) => {
            if (feature.properties.NAME === "Atlanta") {
                layer.setStyle({
                    color: a.countyOutlineColor,
                    fillOpacity: 0,
                    weight: 4,
                });
                layer.bindTooltip("Atlanta City Limits");
            }
            else {
                layer.setStyle({
                    fillOpacity: 0,
                    weight: 0,
                    interactive: false
                });
            }

        }
    }).addTo(map); //using Leaflet

    // Aggregate race totals per county from the block-group census data, for the
    // county-level popup used on non-core counties (see countyOutlines below).
    const countyRaceStats = {};
    if (acsData && acsData.features) {
        acsData.features.forEach((feature) => {
            const census = feature.properties.census;
            if (!census) return;
            const county = feature.properties.COUNTYFP;
            if (!countyRaceStats[county]) {
                countyRaceStats[county] = { total: 0, white: 0, black: 0 };
            }
            countyRaceStats[county].total += Number(census[a.vars.totalV]) || 0;
            countyRaceStats[county].white += Number(census[a.vars.whiteV]) || 0;
            countyRaceStats[county].black += Number(census[a.vars.blackV]) || 0;
        });
    }

    // The rest of Georgia (every county outside the 11-county region), as a flat backdrop
    // fill in its own pane below everything else - context only, not a data layer, so it
    // has no popups and shares the same gray as the core-region county outlines.
    let restOfGeorgiaLayer = null;
    if (restOfGeorgia && restOfGeorgia.features && restOfGeorgia.features.length) {
        restOfGeorgiaLayer = L.geoJson(restOfGeorgia, {
            pane: 'restOfGeorgiaPane',
            style: {
                fillColor: a.countyOutlineColor,
                fillOpacity: a.nonCoreFillOpacity,
                color: a.countyOutlineColor,
                weight: 0.5,
                opacity: 1,
                interactive: false
            }
        }).addTo(map);
    }

    // Outline every county in the 11-county Atlanta region (no fill - this is purely a
    // reference layer so county lines stay legible against the demographics choropleth).
    // Fulton/DeKalb outlines stay non-interactive so mouse events pass through to their
    // block-group popups below; every other county's outline is interactive instead and
    // shows one county-level popup rather than per-block-group popups.
    let countyOutlines = null;
    if (countyBoundaries && countyBoundaries.features && countyBoundaries.features.length) {
        countyOutlines = L.geoJson(countyBoundaries, {
            pane: 'countiesPane',
            style: function (feature) {
                const isCoreCounty = a.domain.coreCounties.includes(feature.properties.COUNTYFP);
                return {
                    fillOpacity: 0,
                    color: a.countyOutlineColor,
                    weight: 1.5,
                    opacity: 0.85,
                    interactive: !isCoreCounty
                };
            },
            onEachFeature: (feature, layer) => {
                const isCoreCounty = a.domain.coreCounties.includes(feature.properties.COUNTYFP);
                if (isCoreCounty) return; // block-group popups already cover these counties

                const stats = countyRaceStats[feature.properties.COUNTYFP];
                if (!stats || !stats.total) {
                    layer.bindTooltip(`${feature.properties.NAMELSAD} <br>No recorded population`);
                    return;
                }
                const other = stats.total - stats.white - stats.black;
                layer.bindTooltip(
                    `${feature.properties.NAMELSAD} <br>
white pop: ~ ${((stats.white / stats.total) * 100).toFixed(1)}% <br>
black pop: ~ ${((stats.black / stats.total) * 100).toFixed(1)}% <br>
other pop: ~ ${((other / stats.total) * 100).toFixed(1)}%`
                );
            }
        }).addTo(map);

        // Constrain panning/zooming to the 11-county region, derived from this same geometry
        // so the limit can never drift out of sync with what's actually drawn. minZoom is set
        // one level tighter than the exact bounds-fit zoom so panning to an edge doesn't reveal
        // a lot of empty space beyond the region.
        const regionBounds = countyOutlines.getBounds();
        map.setMaxBounds(regionBounds.pad(0.03));
        map.setMinZoom(map.getBoundsZoom(regionBounds) + 1);
    }

 const layers = {
                "Atlanta City Limits": atlhoe,

            };
    if (demographics) {
        layers["Neighborhood Type (ACS 15-19)"] = demographics;
    }
    if (countyOutlines) {
        layers["Counties"] = countyOutlines;
    }
    if (h3RacialLayer) {
        layers["Neighborhood Type (H3 Grid)"] = h3RacialLayer;
    }
    // restOfGeorgiaLayer is intentionally left out of `layers` - it's always-on backdrop,
    // not a toggleable overlay (it's already .addTo(map) at creation above). The mobility
    // network (points + lines, built in setupODNetwork) is likewise always-on - it's the
    // map's main feature now, not a togglable extra.

    //Legend - extends the built-in layer control with a race color-swatch key,
    // the same pattern used for the participant-type legend in indexWIP.html.
    const RaceLayerControl = L.Control.Layers.extend({
        onAdd: function (map) {
            const container = L.Control.Layers.prototype.onAdd.call(this, map);
            const legend = L.DomUtil.create('div', 'race-legend', container);
            let legendHTML = '<strong>Neighborhood Type</strong><br>';
            Object.entries(a.raceColors).forEach(([label, color]) => {
                legendHTML += `<i style="background:${color}; width: 14px; height: 14px; display: inline-block; margin-right: 6px; border: 1px solid rgba(0,0,0,0.2);"></i>${label}<br>`;
            });
            legend.innerHTML = legendHTML;
            addRaceInfoIcon(legend);
            return container;
        }
    });
    const layerControl = new RaceLayerControl(null, layers, { collapsed: false }).addTo(map);
}

// --- Mobility (OD) network ---
// Ported from Participant_ODNetwork_MobilityMode.html. There, this data was fetched
// separately; here `points` is already loaded by getLocalData(), so this just groups it
// by participant and builds the same points/lines/legend/dropdown UI directly on `map`.
function setupODNetwork(pointsGeojson) {
    const groupedRoutes = {};
    const participantSet = new Set();
    const participantNames = {}; // id -> participantName, for the dropdown labels

    pointsGeojson.features.forEach(feature => {
        const participantId = feature.properties.layer;
        const coords = {
            lat: feature.geometry.coordinates[1],
            lng: feature.geometry.coordinates[0],
            // Used by fetchGoogleDirections below: the destination point's `mode`
            // decides which routed path to draw for pairs touching it.
            mode: feature.properties.mode,
            description: feature.properties.description,
            participantName: feature.properties.participantName
        };

        if (!participantId) return;
        participantSet.add(participantId);
        participantNames[participantId] = feature.properties.participantName;

        if (!groupedRoutes[participantId]) {
            groupedRoutes[participantId] = [];
        }
        groupedRoutes[participantId].push(coords);
    });

    // Populate the dropdown - value stays the "P#" id (everything internally keys off
    // that), but the label shown to the user is the participant's name.
    const selectElement = document.getElementById("participantSelect");
    if (selectElement) {
        [...participantSet]
            .sort((x, y) => parseInt(x.replace(/\D/g, ''), 10) - parseInt(y.replace(/\D/g, ''), 10))
            .forEach(id => {
                const option = document.createElement("option");
                option.value = id;
                option.textContent = participantNames[id] || `Participant ${id}`;
                selectElement.appendChild(option);
            });
        selectElement.addEventListener("change", () => {
            highlightedLines = [];
            highlightedMarkerPoints = [];
            highlightTriggerType = null;
            highlightParticipantRoutes();
        });
    }

    allGroupedRoutes = groupedRoutes; // for the bounding-box rectangle later

    // Process routes for each participant. Each fetch function registers its own line
    // into allRoutes directly (with its start/end points attached), rather than being
    // collected here after the fact - needed so highlightParticipantRoutes() can later
    // find "every line touching point X".
    Object.keys(groupedRoutes).forEach(participantId => {
        let routeLines = drawStraightLineRoutes(groupedRoutes[participantId], participantId);
        routeLayers[participantId] = routeLines;
    });

    styleWayPoints(groupedRoutes);
    buildLegend(participantNames);

    // Show the full (unfiltered) network by default.
    highlightParticipantRoutes();
}

function drawStraightLineRoutes(points, participantId) {
    let lines = [];
    const color = getParticipantColor(participantId);

    // Create a fully connected matrix where every point is linked to every other, each
    // pair drawn exactly once (i < j, not i !== j) since a straight line from A to B is
    // visually identical to one from B to A.
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const startCoords = points[i];
            const endCoords = points[j];

            fetchStraightLineRoute(startCoords, endCoords, lines, color, participantId, endCoords.mode);

            // Real routed path drawn on top of the straight line, mode decided by the
            // destination point (points[j] in this pair). Note there's no real trip
            // chronology in this data - "destination" just means whichever point comes
            // second in this loop's pairing. Waits for the Google Maps SDK to actually
            // be ready (googleMapsReady, resolved from window.initMap) instead of
            // assuming `google` already exists.
            if (routedParticipants.includes(participantId)) {
                googleMapsReady.then(() => {
                    fetchGoogleDirections(startCoords, endCoords, endCoords.mode, lines, participantId);
                });
            }
        }
    }

    return lines;
}

// Google Directions results are cached in localStorage, keyed by start/end/mode, since
// the same fixed participant points get re-routed on every single page load otherwise -
// during development this ran the request count up into the thousands. Routes between
// fixed points don't change day to day, so the cache lives far longer (30 days) than the
// generic 6-minute app-data cache above (retrieveData/storeData), which exists for a
// different purpose (avoiding refetching Census/geometry data within one dev session).
const ROUTE_CACHE_HOURS = 24 * 30;

function routeCacheKey(startCoords, endCoords, mode) {
    return `googleRoute_${mode}_${startCoords.lat.toFixed(6)},${startCoords.lng.toFixed(6)}` +
        `_${endCoords.lat.toFixed(6)},${endCoords.lng.toFixed(6)}`;
}

// Returns: undefined if nothing cached yet (caller should fetch), null if this pair was
// already queried and Google returned no route for it (caller should skip - no point
// re-querying a known-failed lookup every load), or the cached latLngs array on success.
function getCachedRoute(key) {
    const cached = localStorage.getItem(key);
    if (!cached) return undefined;
    const { timestamp, latLngs } = JSON.parse(cached);
    if (checkExpired(timestamp, ROUTE_CACHE_HOURS)) {
        localStorage.removeItem(key);
        return undefined;
    }
    return latLngs;
}

function cacheRoute(key, latLngs) {
    try {
        localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), latLngs }));
    } catch (e) {
        // Most likely localStorage is full - not fatal, just means this pair will
        // re-fetch from Google next load instead of hitting the cache.
        console.warn('Failed to cache route (localStorage full?):', e);
    }
}

// Draws the routed polyline and registers it into allRoutes/lines - shared by both the
// cache-hit path and the live Google Directions response, so they can't drift apart.
function drawRoutedPolyline(latLngs, startCoords, endCoords, mode, lines, participantId) {
    const polyline = L.polyline(latLngs, {
        pane: 'networkLinesPane',
        color: getParticipantColor(participantId),
        weight: 4,
        opacity: 0.8
    }).addTo(map);
    lines.push(polyline);

    // type:'routed' keeps this line at its thicker, solid weight in
    // highlightParticipantRoutes() - dashing is what distinguishes it from the
    // straight-line reference now, not color. Tooltip binding is handled centrally in
    // highlightParticipantRoutes() too, since it needs to turn off for non-visible lines
    // - see that function.
    const routedEntry = { routeLine: polyline, participantId, type: 'routed', startCoords, endCoords, mode };
    allRoutes.push(routedEntry);

    // The straight line for this exact pair was already created (synchronously, before
    // this routed one) - find it by matching the same start/end point objects and link
    // the two together, so clicking either one (once isolated) can highlight both as a
    // pair. Straight-line side of the link is set here since this routed line didn't
    // exist yet when it was made.
    const siblingStraight = allRoutes.find(e =>
        e !== routedEntry && e.type === 'straight' &&
        e.participantId === participantId &&
        e.startCoords === startCoords && e.endCoords === endCoords
    );
    if (siblingStraight) {
        siblingStraight.pairedWith = routedEntry;
        routedEntry.pairedWith = siblingStraight;
    }

    polyline.on('click', () => handleLineClick(routedEntry));
    highlightParticipantRoutes(); // apply current selection/highlight state immediately
}

function fetchGoogleDirections(startCoords, endCoords, mode, lines, participantId) {
    const travelModeKey = googleTravelModeMap[mode];
    if (!travelModeKey) {
        console.warn(`No Google travel mode mapped for "${mode}" - skipping`, startCoords, '->', endCoords);
        return;
    }

    const cacheKey = routeCacheKey(startCoords, endCoords, mode);
    const cached = getCachedRoute(cacheKey);
    if (cached !== undefined) {
        if (cached) drawRoutedPolyline(cached, startCoords, endCoords, mode, lines, participantId);
        // cached === null means this pair was already queried and had no route - skip silently.
        return;
    }

    const request = {
        origin: { lat: startCoords.lat, lng: startCoords.lng },
        destination: { lat: endCoords.lat, lng: endCoords.lng },
        travelMode: google.maps.TravelMode[travelModeKey]
    };

    directionsService.route(request, (result, status) => {
        if (status !== 'OK' || !result.routes || !result.routes[0]) {
            console.warn(`No ${mode} (Google mode: ${travelModeKey}) route returned for`, startCoords, '->', endCoords, status);
            cacheRoute(cacheKey, null); // remember this pair has no route - don't re-query it every load
            return;
        }

        // overview_path is an array of google.maps.LatLng objects - .lat()/.lng() are
        // methods on that class, not plain properties, and Leaflet wants [lat, lng].
        const latLngs = result.routes[0].overview_path.map(p => [p.lat(), p.lng()]);
        cacheRoute(cacheKey, latLngs);
        drawRoutedPolyline(latLngs, startCoords, endCoords, mode, lines, participantId);
    });
}

function fetchStraightLineRoute(startCoords, endCoords, lines, color, participantId, mode) {
    const polyline = L.polyline([
        [startCoords.lat, startCoords.lng],
        [endCoords.lat, endCoords.lng]
    ], {
        pane: 'networkLinesPane',
        color: color || modeColors['str_line'],
        weight: 2,
        opacity: 0.6,
        dashArray: '1,10'
    }).addTo(map);

    lines.push(polyline);
    const entry = { routeLine: polyline, participantId, type: 'straight', startCoords, endCoords, mode };
    allRoutes.push(entry);
    // pairedWith gets set later, from fetchGoogleDirections, once/if the routed version
    // of this same pair arrives (it's async and hasn't run yet at this point).

    polyline.on('click', () => handleLineClick(entry));
}

// If this line's own participant is already the isolated one, highlight it and its
// straight/routed counterpart in bright orange instead of re-isolating (which would be a
// no-op anyway). Any other click - a different participant's line, or nothing isolated
// yet - isolates that network fresh, same as clicking one of its points.
function handleLineClick(entry) {
    const selectElement = document.getElementById("participantSelect");
    if (!selectElement) return;
    const selectedId = selectElement.value;
    if (selectedId === entry.participantId) {
        highlightedLines = [entry, entry.pairedWith].filter(Boolean);
        highlightedMarkerPoints = [entry.startCoords, entry.endCoords];
        highlightTriggerType = 'line';
    } else {
        highlightedLines = [];
        highlightedMarkerPoints = [];
        highlightTriggerType = null;
        selectElement.value = entry.participantId;
    }
    highlightParticipantRoutes();
}

function styleWayPoints(groupedRoutes) {
    const iconCache = {}; // keyed by "description|color" to avoid rebuilding duplicates

    for (const id in groupedRoutes) {
        const color = getParticipantColor(id);
        groupedRoutes[id].forEach((point) => {
            const shapeUrl = descriptionShapes[point.description];
            if (!shapeUrl) return;

            const isHome = point.description === 'Home';
            const cacheKey = `${point.description}|${color}`;
            if (!iconCache[cacheKey]) {
                iconCache[cacheKey] = isHome
                    ? coloredHomeIcon(shapeUrl, color)
                    : coloredShapeIcon(shapeUrl, color);
            }

            const marker = L.marker([point.lat, point.lng], { icon: iconCache[cacheKey], pane: 'pointsPane' })
                .addTo(map);
            // Tooltip binding is managed centrally in highlightParticipantRoutes() - it
            // needs to turn off for markers outside the isolated network, so it isn't
            // just bound once here. Using bindTooltip (hover-native) rather than
            // bindPopup (click-native) keeps this from competing with the click below.

            // If this point's own network is already isolated, highlight every line
            // touching it (however many that is) plus the point itself, instead of
            // re-isolating (a no-op anyway, since it's already isolated). Any other
            // click - a different participant's point, or nothing isolated yet -
            // isolates that network fresh, same as clicking one of its lines.
            marker.on('click', () => {
                const selectElement = document.getElementById("participantSelect");
                if (!selectElement) return;
                const selectedId = selectElement.value;
                if (selectedId === id) {
                    highlightedLines = allRoutes.filter(e =>
                        e.participantId === id &&
                        (e.startCoords === point || e.endCoords === point)
                    );
                    highlightedMarkerPoints = [point];
                    highlightTriggerType = 'point';
                } else {
                    highlightedLines = [];
                    highlightedMarkerPoints = [];
                    highlightTriggerType = null;
                    selectElement.value = id;
                }
                highlightParticipantRoutes();
            });

            allMarkers.push({
                marker,
                participantId: id,
                tooltipText: `${point.participantName || id}: ${point.description || ''}`,
                point,
                normalIcon: iconCache[cacheKey]
            });
        });
    }
}

// Builds the legend from the same participantColors/descriptionShapes data driving the
// map itself, rather than a hand-written list, so it can't drift out of sync.
function buildLegend(participantNames) {
    const legendEl = document.getElementById('legend');
    if (!legendEl) return;

    const colorRows = Object.keys(participantNames)
        .sort((x, y) => parseInt(x.replace(/\D/g, ''), 10) - parseInt(y.replace(/\D/g, ''), 10))
        .map(id => {
            const color = getParticipantColor(id);
            return `<div><span class="swatch" style="background:${color};"></span>${participantNames[id]}</div>`;
        }).join('');

    const shapeRows = Object.keys(descriptionShapes).map(description => {
        const maskCss = `url('${descriptionShapes[description]}') center / contain no-repeat`;
        return `<div><span class="shape-swatch" style="-webkit-mask:${maskCss};mask:${maskCss};"></span>${description}</div>`;
    }).join('');

    legendEl.innerHTML =
        '<strong>Participants</strong>' + colorRows +
        '<strong>Place Type</strong>' + shapeRows;
}

// Draws (or removes) a static rectangle framing the isolated network's full extent -
// purely visual, doesn't move the camera. Called from highlightParticipantRoutes(), which
// now runs on every line click too (for the orange pair-highlight) - skip the rebuild
// whenever the isolated participant hasn't actually changed, otherwise this was tearing
// down and recreating an identical rectangle on every single line click.
function updateNetworkBoundingBox(selectedId) {
    if (selectedId === boundingBoxParticipantId) return;
    boundingBoxParticipantId = selectedId || null;

    if (networkBoundingBox) {
        map.removeLayer(networkBoundingBox);
        networkBoundingBox = null;
    }

    const netPoints = selectedId && allGroupedRoutes[selectedId];
    if (!netPoints || !netPoints.length) return;

    const bounds = L.latLngBounds(netPoints.map(p => [p.lat, p.lng]));
    networkBoundingBox = L.rectangle(bounds, {
        pane: 'networkLinesPane',
        color: '#FFFFFF',
        weight: 3,
        fill: false,
        interactive: false
    }).addTo(map);
}

function tripTooltipText(startCoords, endCoords, mode) {
    // Double-headed arrow deliberately, not a single-headed one - these lines represent
    // an undirected pair (see drawStraightLineRoutes), not a recorded direction of
    // travel, so the tooltip shouldn't visually imply one.
    return `${startCoords.description || 'Start'} ↔ ${endCoords.description || 'End'} (${mode})`;
}

function highlightParticipantRoutes() {
    const selectElement = document.getElementById("participantSelect");
    const selectedId = selectElement ? selectElement.value : "";
    updateNetworkBoundingBox(selectedId);

    // When a line click highlighted a straight+routed pair, both turn orange, but only
    // ONE should show a forced-open tooltip (otherwise they overlap) - prefer the routed
    // one since it's the real path, falling back to whichever's actually highlighted
    // when there's no routed counterpart (no routing on this participant, or Google
    // couldn't route that particular pair).
    const tooltipTargetLine = highlightTriggerType === 'line'
        ? (highlightedLines.find(e => e.type === 'routed') || highlightedLines[0] || null)
        : null;

    // Both line types always use their participant's color - routed and straight are
    // told apart by weight/dash (set at creation: routed is thick and solid, straight is
    // thin and dashed), not by color. Selection only ever changes opacity, never color or
    // weight, so "nothing selected" still shows the full per-participant scheme rather
    // than graying everything out. On top of that, whatever's in highlightedLines (either
    // a clicked line + its counterpart, or every line touching a clicked point) overrides
    // to that participant's own highlight color - a vivid, saturated version of their
    // assigned pastel hue, not one fixed color shared by everyone.
    allRoutes.forEach((entry) => {
        const { routeLine, participantId, type, startCoords, endCoords, mode } = entry;
        const isVisible = !selectedId || participantId === selectedId;
        const isHighlightedLine = participantId === selectedId && highlightedLines.includes(entry);

        if (isHighlightedLine) {
            routeLine.setStyle({
                color: getHighlightColor(participantId),
                weight: type === 'routed' ? 8 : 3,
                opacity: 1
            });
        } else {
            const color = getParticipantColor(participantId);
            // Both line types get a wider, easier-to-click hitbox once their network is
            // actually isolated (a specific participant selected, not the default
            // "nothing selected, everyone shown thin" state) - dimmed lines belonging to
            // other participants stay thin, same as the default view, since there's no
            // reason to widen a click target that's barely visible anyway.
            const isIsolatedForThisLine = selectedId && isVisible;
            const weight = isIsolatedForThisLine ? 4 : 2;
            const visibleOpacity = type === 'routed' ? 0.8 : 0.6;
            routeLine.setStyle({ color, weight, opacity: isVisible ? visibleOpacity : 0.15 });
        }

        // Tooltips only stay bound on visible lines - dimmed/hidden lines outside the
        // isolated network shouldn't show their info on hover. Only tooltipTargetLine
        // (computed above - the routed half of a highlighted pair, when one exists) gets
        // permanent:true instead of the normal hover-only tooltip, so it stays visible
        // with no open/close event needed at all. Always unbind first (if a tooltip
        // exists) rather than only conditionally rebinding when something looks out of
        // date - a "skip if already correct" check here was leaving Leaflet's internal
        // tooltip state inconsistent in some edge case and crashing inside its own
        // Tooltip.js on a later call.
        const shouldForceOpen = entry === tooltipTargetLine;
        if (routeLine.getTooltip()) {
            routeLine.unbindTooltip();
        }
        if (isVisible) {
            routeLine.bindTooltip(tripTooltipText(startCoords, endCoords, mode), { permanent: shouldForceOpen });
        }

        // Dimmed lines belonging to other participants stay in the DOM (still needed for
        // their own opacity/position) but stop accepting clicks/hovers entirely while a
        // network is isolated - otherwise, in dense areas, an overlapping dimmed line can
        // steal a click meant for the isolated network's own thin line underneath/nearby.
        // Avoided bringToFront()-style z-order tricks here deliberately, since that
        // already caused its own hover-confusion bug earlier.
        const lineEl = routeLine.getElement();
        if (lineEl) lineEl.style.pointerEvents = isVisible ? '' : 'none';
    });

    // Points follow the same rule as their network's lines: full opacity when nothing's
    // selected or they belong to the selected participant, dimmed otherwise - and
    // likewise, tooltips only stay active on the currently-visible points.
    allMarkers.forEach(({ marker, participantId, tooltipText, point, normalIcon }) => {
        const isVisible = !selectedId || participantId === selectedId;
        // Home markers stay fully visible and clickable regardless of isolation state
        // (see the pointer-events note below) - they're the deliberate, discoverable way
        // to jump to a different participant's network, so dimming them to 0.15 like
        // everything else would defeat that purpose even though they're still technically
        // clickable underneath.
        const isHome = point.description === 'Home';
        marker.setOpacity(isVisible || isHome ? 1 : 0.15);

        // Highlighted points (either a clicked line's two endpoints, or a single clicked
        // point) get swapped to that participant's own highlight color icon either way -
        // color highlighting doesn't depend on trigger type, only the tooltip-forcing
        // below does. Everyone else keeps their normal icon.
        const isHighlightedPoint = participantId === selectedId && highlightedMarkerPoints.includes(point);
        marker.setIcon(isHighlightedPoint ? getHighlightIcon(point.description, participantId) : normalIcon);

        // Point tooltips only force open when a POINT was clicked - if a line click
        // highlighted this point as one of its endpoints, it still turns orange but its
        // tooltip stays off, since a line click should only surface the route's own
        // tooltip (see the mirrored rule on shouldForceOpen above). permanent:true needs
        // no open/close event at all, unlike openTooltip() which raced against setIcon()'s
        // DOM replacement above and intermittently lost. Always unbind first (if a
        // tooltip exists) rather than conditionally skipping the rebind - that "skip if
        // already correct" check was leaving Leaflet's internal tooltip state
        // inconsistent in some edge case and crashing inside its own Tooltip.js.
        const shouldForceOpen = isHighlightedPoint && highlightTriggerType === 'point';
        if (marker.getTooltip()) {
            marker.unbindTooltip();
        }
        if (isVisible) {
            marker.bindTooltip(tooltipText, { permanent: shouldForceOpen });
        }

        // Same reasoning as the line loop above: dimmed points from other participants
        // stop accepting clicks while a network is isolated, so they can't steal a click
        // meant for one of the isolated network's own points. Home markers (isHome,
        // computed above) are the deliberate exception - see the comment on that line for why.
        const markerEl = marker.getElement();
        if (markerEl) markerEl.style.pointerEvents = (isVisible || isHome) ? '' : 'none';
    });
}

// Selects a participant in the network dropdown (used by the story side-pane buttons
// below) and isolates their network, exactly as if the user had picked them from the
// dropdown or clicked one of their points/lines directly.
function isolateParticipantNetwork(participantId) {
    const selectElement = document.getElementById("participantSelect");
    if (!selectElement) return;
    selectElement.value = participantId;
    highlightedLines = [];
    highlightedMarkerPoints = [];
    highlightTriggerType = null;
    highlightParticipantRoutes();
}

function setupEventListeners(map) {
    const participants = {
        "btn-1": { contentId: "debra-1", participantId: "P6" },
        "btn-2": { contentId: "emily-1", participantId: "P2" },

    };

    Object.keys(participants).forEach(buttonId => {
        document.getElementById(buttonId).addEventListener("click", function () {
            const { contentId, participantId } = participants[buttonId];

            switchContent(contentId);
            isolateParticipantNetwork(participantId);
        });
    });
}

// Function to switch content in the sidebar
function switchContent(contentId) {
    console.log("Switching content to:", contentId);

    // Hide all content-divs
    document.querySelectorAll('.content-div').forEach(div => {
        div.style.display = 'none';
    });

    // Show the selected content
    let selectedContent = document.getElementById(contentId);
    if (selectedContent) {
        selectedContent.style.display = 'block';
    } else {
        console.error("Content ID not found:", contentId);
    }
}

document.querySelectorAll(".next-btn").forEach(button => {
    button.addEventListener("click", function () {
        let currentDiv = this.parentElement.id; // Get current div ID
        let nextDivId = this.dataset.next; // Get the 'data-next' value

        if (nextDivId) {
            nextContent(currentDiv, nextDivId);
        } else {
            console.error("No 'data-next' attribute found on this button");
        }
    });
});

document.addEventListener("DOMContentLoaded", function () {
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const container = document.querySelector('.container-fluid');
    const musicElement = document.getElementById('background-music');
    const volumeSlider = document.getElementById("volume-slider");

    // Set the initial volume
    musicElement.volume = volumeSlider.value;

    // Update volume when slider moves
    volumeSlider.addEventListener("input", function () {
        musicElement.volume = this.value;
    });

    fullscreenBtn.addEventListener('click', function (event) {
        event.preventDefault();

        if (!document.fullscreenElement) {
            // Enter fullscreen
            if (container.requestFullscreen) {
                container.requestFullscreen();
            } else if (container.mozRequestFullScreen) {
                container.mozRequestFullScreen();
            } else if (container.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (container.msRequestFullscreen) {
                container.msRequestFullscreen();
            }

            // Play music when entering fullscreen
            if (musicElement) {
                musicElement.play();
            }
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }

            // Pause music when exiting fullscreen
            if (musicElement) {
                musicElement.pause();
            }
        }
    });
});


// Get all navigation links
const navLinks = document.querySelectorAll('.nav-link');

// Add click event listeners to each link
navLinks.forEach(link => {
    link.addEventListener('click', function (event) {
        // Prevent default link behavior (optional)
        event.preventDefault();

        // Remove the 'active' class from all links
        navLinks.forEach(link => link.classList.remove('active'));

        // Add the 'active' class to the clicked link
        this.classList.add('active');

        // Optional: Navigate to the link's href
        window.location.href = this.href;
    });
});
// Get the current page URL
const currentPage = window.location.href;

// Loop through each link and check if it matches the current page
navLinks.forEach(link => {
    if (link.href === currentPage) {
        link.classList.add('active');
    }
});
