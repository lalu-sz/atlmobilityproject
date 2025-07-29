import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
// Add footer date

let map;
let points = null; // Global variable to store points (needed for routing)

let routeLayers = {};
let allRoutes = [];
let directionsService;


// basically recreating URL with variables
const a = {
    data: {},
    domain: {
        unit: "block%20group",
        state: ['13'], // ["*"], 
        county: ['089', '121'],
        tract: ["*"],
        block_group: ["*"],
        data: "2019/acs/acs5",
    },
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

    ],
    vars: {
        totalV: "totalPopulation",
        blackV: "blackPopulation"
    },
    geojson: {
        counties: "data/fultonDekalbBG.json",
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
        const zcta = await d3.json("data/fdZCTA.geojson");
        points = await d3.json("data/ParticipantPointsMerged.geojson");
       
        const homeLoc = await d3.json("data/dislocated_HLs.geojson");
        const places = await d3.json("data/gaPlaces.geojson");
        const roads = await d3.json("data/atlRoadsHoe.geojson");

        return { zcta, homeLoc, points, places, roads };
    } catch (error) {
        console.error("ERROR!", error);
        return null;
    }
}




async function setupMap(zcta, homeLoc, points, places) {
    let options = {
        center: [33.748997, -84.387985],
        zoom: 13,
        scrollWheelZoom: false
    };

    // Retrieve cached map options
    if (retrieveData('mapOptions')) {
        console.log('Using cached map options');
        options = retrieveData('mapOptions');
    }

    // Initialize the map and assign it to the global variable `map`
    map = L.map('map').setView(options.center, options.zoom);

    //Style URL: mapbox://styles/lalu-sz-/cltc7cx6n03d001p65ybi1sjz   
    // Add Mapbox's tile layer using your custom style URL
    L.tileLayer('https://api.mapbox.com/styles/v1/lalu-sz-/cltc7cx6n03d001p65ybi1sjz/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoibGFsdS1zei0iLCJhIjoiY2xzdjM4cm90MmJ6bDJsbWpqejJneDhzNCJ9.bja8-N3mGgqGqJXjzu8lrA', {
        attribution: 'Map data &copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> contributors',
        maxZoom: 18,
        access_token: 'pk.eyJ1IjoibGFsdS1zei0iLCJhIjoiY2xzdjM4cm90MmJ6bDJsbWpqejJneDhzNCJ9.bja8-N3mGgqGqJXjzu8lrA'  // Replace with your Mapbox access token
    }).addTo(map);


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
    const url = `https://api.census.gov/data/${a.domain.data}?get=NAME,${variables}&for=${a.domain.unit}:*&in=state:${a.domain.state}&in=county:${a.domain.county}&in=tract:${a.domain.tract}`;
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
    countyGeom.features.forEach((feature) => {

        feature.properties.joinField = feature.properties.TRACTCE + feature.properties.BLKGRPCE;
    });

    // Loop through the census data.
    for (const census of censusData) {
        // Slice off last two elements, concatenate, and assign to countyFips.
        // The -2 index is the second to last element in the array.
        const countyFips = census.slice(-2).join("");
        //console.log(countyFips); //7 (tract and block)

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

    let { zcta, homeLoc, points, places, roads } = dataUpload;
    points = dataUpload.points; // Global access to points

    console.log(points.features);
    if (!points || !points.features) {
        console.error("Points data is missing or invalid.");
        return;
    }

    // Wait for the map to be ready before calling nextContent
    setupMap(zcta, homeLoc, points, places, roads).then((initializedMap) => {
        map = initializedMap;  // Ensure map is assigned globally
        //createRoutes(points, map);
        getCensus().then((acsData) => {
            drawMap(zcta, homeLoc, points, places, roads, map, acsData);
            setupEventListeners(map);
        }).catch(error => {
            console.error("Failed to fetch census data:", error);
        });
    }).catch(error => {
        console.error("Failed to set up the map:", error);
    });
});

// Display GeoJSON
function drawMap(zcta, homeLoc, points, places, roads, map, acsData) {
    // Create custom panes with specific zIndex values
    map.createPane('suburbsPane');
    map.getPane('suburbsPane').style.zIndex = 200; // Lowest zIndex

    map.createPane('demographicsPane');
    map.getPane('demographicsPane').style.zIndex = 200;

    map.createPane('atlantaPane');
    map.getPane('atlantaPane').style.zIndex = 400;

    map.createPane('homesPane');
    map.getPane('homesPane').style.zIndex = 500;

    map.createPane('pointsPane');
    map.getPane('pointsPane').style.zIndex = 600; // Highest zIndex

    //census data first
    const color = d3.scaleQuantile()
        .domain([0.0, 1.0])
        .range(["#f9f6f6", "#cfb0b0", "#4f3030", "#170909"]);
    color.domain(acsData.features.map((d) => {
        return (d.properties.census[a.vars.blackV] / d.properties.census[a.vars.totalV]);
    }
    ));

    const demographics = L.geoJson(acsData, {
        pane: 'demographicsPane', // Assign to demographicsPane
        style: function (feature) {
            const rate = (feature.properties.census[a.vars.blackV] / feature.properties.census[a.vars.totalV]);
            return {
                fillColor: color(rate),
                weight: 0.25,
                opacity: 1,
                color: color(rate),
                fillOpacity: 1,
            };
        },
        onEachFeature: function (feature, layer) {
            layer.bindTooltip(
                `Community: ${feature.properties.TRACTCE}-${feature.properties.BLKGRPCE}: <br>
black pop: ~ ${(
                    (feature.properties.census[a.vars.blackV] / feature.properties.census[a.vars.totalV]) *
                    100
                ).toFixed(1)}% <br>
white pop: ~ ${(
                    (1 - feature.properties.census[a.vars.blackV] / feature.properties.census[a.vars.totalV]) *
                    100
                ).toFixed(1)}%`
            );
        },
    })

    // Define the SVG icon for home location
    const iconUrl = "mapbox-maki-8.2.0-0-g6ab50f3/mapbox-maki-6ab50f3/icons/home.svg";
    const svgIcon = L.divIcon({
        html: `<img src="${iconUrl}" alt="Home Icon" width="32" height="32" />`, // Use an <img> tag to load the external SVG
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
        className: 'custom-icon' // Apply the CSS class
    });

    // Create a Leaflet GeoJSON layer with style and popup
    const homes = L.geoJSON(homeLoc, { //change symbol
        pointToLayer: (feature, latlng) => {
            return L.marker(latlng, {
                icon: svgIcon
            });
        },
        onEachFeature: (feature, layer) => {
            if (feature.properties) {
                const alias = (feature.properties.aliasName);
                layer.bindPopup(
                    `<h3>${alias}'s neighborhood</h3>
`
                );
            }
        }
    }).addTo(map);

    // Create a Leaflet GeoJSON layer with style and popup
    pointsLayer = L.geoJSON(points, { //change symbol
        pointToLayer: (feature, latlng) => {
            return L.circleMarker(latlng, {
                radius: 6,
                fillColor: "gray"

            });
        },
    }).addTo(map);


    const atlhoe = L.geoJSON(places, {
        pane: 'atlantaPane', // Assign to atlantaPane
        onEachFeature: (feature, layer) => {
            if (feature.properties.NAME === "Atlanta") {
                layer.setStyle({
                    color: '#efab00',
                    fillOpacity: 0,
                    weight: 4,
                    dashArray: '2,6',
                });
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

 const layers = {
                "Race": demographics,
                "Particpant Neigborhoods": homes,
                "Boundary": atlhoe,

            };

    //Legend
   layerControl = L.control.layers(null,layers, { collapsed: false}).addTo(map);

    // Check for locations stored by user in localStorage
    // if locations exist, draw them on the map
    if (retrieveData('locations')) {
        const allLocations = retrieveData('locations')
        console.log(allLocations)
        drawLocations(map, homes, allLocations)
    }
}
function setupEventListeners(map) {
    const participants = {
        "btn-1": { contentId: "debra-1", participantId: "p6" },
        "btn-2": { contentId: "emily-1", participantId: "p2" },

    };

    Object.keys(participants).forEach(buttonId => {
        document.getElementById(buttonId).addEventListener("click", function () {
            const { contentId, participantId } = participants[buttonId];

            switchContent(contentId);
            highlightParticipantRoutes(participantId, map);
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


function highlightParticipantRoutes(selectedParticipantId, map) {
    console.log("Highlighting route for participant:", selectedParticipantId);

    // Convert selected ID to lowercase for case-insensitive comparison
    const normalizedSelectedId = selectedParticipantId.toLowerCase();

    console.log("All Routes:", allRoutes);

    // Reset all routes to default
    allRoutes.forEach(({ routeLine }) => {
        routeLine.setStyle({ color: "#f5f9e8", weight: 4, opacity: 0.3 });
    });

    // Highlight only the selected participant’s routes
    allRoutes.forEach(({ routeLine, participantId }) => {
        const normalizedRouteId = participantId.toLowerCase(); // Convert each stored ID to lowercase

        console.log(`Checking route: ${normalizedRouteId} === ${normalizedSelectedId}`);

        if (normalizedRouteId === normalizedSelectedId) {
            routeLine.setStyle({ color: "yellow", weight: 6, opacity: 1 });
            routeLine.bringToFront();
        }
    });

    //map updates
    map.invalidateSize();
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