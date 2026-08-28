import { haversineDistance } from "../airports.js";
import { formatFlightDateCombined, unifyRawFlight } from "../flight-normalizer.js";
import { addDaysUTC, minutesBetween, parseFlightDateTime } from "../dates.js";
import {
  buildGraph,
  candidateHasValidFlightDates,
  findCandidateRoutes
} from "./candidate-builder.js";

export function buildOneStopRoute(first, second, gapMinutes, airportLookup = {}) {
  const departureDate = first.calculatedDuration?.departureDate;
  const arrivalDate = second.calculatedDuration?.arrivalDate;
  if (!(departureDate instanceof Date) || !(arrivalDate instanceof Date)) return null;
  const departureUtc = first.departureDateUtc ?? departureDate;
  const arrivalUtc = second.arrivalDateUtc ?? arrivalDate;
  const totalMinutes = minutesBetween(departureUtc, arrivalUtc);
  const transferFrom = first.arrivalStation;
  const transferTo = second.departureStation;
  const fromLocation = airportLookup[transferFrom];
  const toLocation = airportLookup[transferTo];
  const distanceKm = fromLocation && toLocation
    ? Math.round(haversineDistance(
      fromLocation.latitude, fromLocation.longitude,
      toLocation.latitude, toLocation.longitude
    ))
    : null;

  return {
    key: `${first.key} | ${second.key}`,
    fareSellKey: first.fareSellKey,
    departure: first.departure,
    arrival: second.arrival,
    departureStation: first.departureStation,
    departureStationText: first.departureStationText,
    arrivalStation: second.arrivalStation,
    arrivalStationText: second.arrivalStationText,
    departureDate: first.departureDate,
    arrivalDate: second.arrivalDate,
    stops: "1 transfer",
    totalConnectionTime: gapMinutes,
    airportChange: { from: transferFrom, to: transferTo, distanceKm },
    segments: [first, second],
    calculatedDuration: {
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
      totalMinutes,
      departureDate,
      arrivalDate
    },
    formattedFlightDate: formatFlightDateCombined(departureDate, arrivalDate),
    currency: first.currency,
    displayPrice: first.displayPrice,
    priceTag: first.priceTag,
    route: [first.departureStationText, second.arrivalStationText]
  };
}

export function combineOneStopFlights(firstFlights, secondFlights, {
  minConnection,
  maxConnection,
  airportLookup = {}
}) {
  const results = [];
  for (const first of firstFlights) {
    for (const second of secondFlights) {
      const gap = minutesBetween(
        first.calculatedDuration.arrivalDate,
        second.calculatedDuration.departureDate
      );
      if (gap < minConnection || gap > maxConnection) continue;
      const route = buildOneStopRoute(first, second, gap, airportLookup);
      if (route) results.push(route);
    }
  }
  return results;
}


export function createConnectionsSearch({
  isCancelled,
  debugLogger,
  isDateAvailableForSegment,
  getCachedResults,
  setCachedResults,
  getUnifiedCacheKey,
  checkRouteSegment,
  updateProgress,
  fetchDestinations,
  routeCatalog,
  airportLookup,
  appendRouteToDisplay,
  getSettings,
  getStopoverText
}) {
  async function processSegment(candidate, index, currentDate, previousFlight, bookingHorizon, minConnection, maxConnection, baseMaxDays, selectedDate, routesData) {
    if (index >= candidate.length - 1) {
      // Base case: return one option – an empty array.
      return [[]];
    }
    
    const segOrigin = candidate[index];
    const segDestination = candidate[index + 1];
    let validChains = [];
    
    debugLogger(`--> Processing segment: ${segOrigin} -> ${segDestination}`);
    
    for (let offset = 0; offset <= baseMaxDays; offset++) {
      const dateToSearch = addDaysUTC(currentDate, offset);
      const dateStr = dateToSearch.toISOString().slice(0, 10);
      if (index === 0 && dateStr !== selectedDate) {
        debugLogger(`   Skipping date ${dateStr} for first segment (selected date is ${selectedDate})`);
        continue;
      }
      if (dateToSearch > bookingHorizon) {
        debugLogger(`   Date ${dateStr} exceeds booking horizon; breaking offset loop`);
        break;
      }
      
      // Check flightDates for this segment from routes data
      const routeForSegment = routesData.find(r => {
        const dep = typeof r.departureStation === "object" ? r.departureStation.id : r.departureStation;
        return dep === segOrigin;
      });
      if (routeForSegment) {
        const arrivalObj = routeForSegment.arrivalStations.find(st => {
          return (typeof st === "object" ? st.id : st) === segDestination;
        });
        if (arrivalObj && arrivalObj.flightDates) {
          if (!arrivalObj.flightDates.includes(dateStr)) {
            debugLogger(`   No available flight on ${dateStr} for segment ${segOrigin} -> ${segDestination} (flightDates filter)`);
            continue;
          }
        }
      }
      if (!isDateAvailableForSegment(segOrigin, segDestination, dateStr)) {
        debugLogger(`   Date ${dateStr} rejected for segment ${segOrigin} -> ${segDestination} (date availability check)`);
        continue;
      }
      
      const cacheKey = getUnifiedCacheKey(segOrigin, segDestination, dateStr);
      debugLogger(`   Checking cache for segment ${segOrigin} -> ${segDestination} on ${dateStr} (cache key: ${cacheKey})`);
      let flights = await getCachedResults(cacheKey);
      if (flights !== null) {
        flights = flights.map(unifyRawFlight);
        debugLogger(`   Cache hit: ${flights.length} flights found for ${segOrigin} -> ${segDestination} on ${dateStr}`);
      } else {
        try {
          flights = await checkRouteSegment(segOrigin, segDestination, dateStr);
          flights = flights.map(unifyRawFlight);
          debugLogger(`   Fetched ${flights.length} flights from server for ${segOrigin} -> ${segDestination} on ${dateStr}`);
          await setCachedResults(cacheKey, flights);
        } catch (error) {
          console.error(`   Error fetching flights for ${segOrigin} -> ${segDestination} on ${dateStr}: ${error.message}`);
          flights = [];
          return [];
        }
      }
      // Convert flight dates if they are not already Date objects.
      flights = flights.map(f => {
        if (!(f.calculatedDuration.departureDate instanceof Date)) {
          f.calculatedDuration.departureDate = parseFlightDateTime(f.departureDateTimeIso, f.departureOffsetText);
        }
        if (!(f.calculatedDuration.arrivalDate instanceof Date)) {
          f.calculatedDuration.arrivalDate = parseFlightDateTime(f.arrivalDateTimeIso, f.arrivalOffsetText);
        }
        return f;
      });
      // Filter flights by "local" date (taking the target offset into account)
      // flights = flights.filter(f => {
      //   f.departureDateIso === dateStr
      //   debugLogger(` Flight ${f.flightCode} rejected: departure date ${f.departureDateIso} does not match ${dateStr}`);
      //   }
      // );
      // debugLogger(`   After local date filtering: ${flights.length} flights remain for ${segOrigin} -> ${segDestination} on ${dateStr}`);
      if (previousFlight) {
        flights = flights.filter(f => {
          const connectionTime = (f.calculatedDuration.departureDate.getTime() - previousFlight.calculatedDuration.arrivalDate.getTime()) / 60000;
          const valid = connectionTime >= minConnection && connectionTime <= maxConnection;
          if (!valid) {
            debugLogger(`      Flight ${f.flightCode} rejected: connection time ${connectionTime} minutes not in [${minConnection}, ${maxConnection}]`);
          }
          return valid;
        });
        debugLogger(`   After connection time filtering: ${flights.length} flights available`);
      }
      
      // Iterate over all found flights for this offset.
      for (let flight of flights) {
        debugLogger(`   Considering flight ${flight.flightCode} for segment ${segOrigin} -> ${segDestination}: Departure: ${flight.calculatedDuration.departureDate.toISOString()}, Arrival: ${flight.calculatedDuration.arrivalDate.toISOString()}`);
        // Recursively process the next segment, passing the date adjusted by the current offset.
        const nextChains = await processSegment(candidate, index + 1, addDaysUTC(currentDate, offset), flight, bookingHorizon, minConnection, maxConnection, baseMaxDays, selectedDate, routesData);
        // For each found option, add the current flight at the beginning.
        for (let chain of nextChains) {
          validChains.push([flight, ...chain]);
        }
      }
    }
    
    if (validChains.length === 0) {
      debugLogger(`   No suitable flight found for segment ${segOrigin} -> ${segDestination} at any offset`);
    }
    return validChains;
  }
  
  /**
   * Searches all one-stop routes allowing an airport change.
   *
   * @param {string[]} origins                – list of origin airport codes
   * @param {string[]} destinations          – list of destination airport codes
   * @param {string}   selectedDate           – YYYY-MM-DD of outbound date
   * @param {number}   minConnection          – minimum layover in minutes
   * @param {number}   maxConnection          – maximum layover in minutes
   * @param {number}   connectionRadiusKm     – max distance between connection airports
   * @param {number[]} allowedOffsets         – [0…n] day offsets for second leg
   * @param {boolean}  shouldAppend           – whether to append results as they arrive
   * @returns {Promise<Route[]>}              – all matching routes
   */
  async function processOneStopWithAirportChange(
    origins,
    destinations,
    selectedDate,
    minConnection,
    maxConnection,
    connectionRadiusKm,
    allowedOffsets,
    shouldAppend
  ) {
    debugLogger("[DEBUG] airport-change search start", {
      origins,
      destinations,
      selectedDate,
      minConnection,
      maxConnection,
      connectionRadiusKm,
      allowedOffsets,
    });

      // Compute booking horizon (today + 3 days)
    const todayUTC = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z");
    const bookingHorizon = addDaysUTC(todayUTC, 3);
    // Filter allowedOffsets so that selectedDate + offset ≤ bookingHorizon
    allowedOffsets = allowedOffsets.filter(offset => {
      const candidateDate = addDaysUTC(new Date(selectedDate + "T00:00:00Z"), offset);
      return candidateDate <= bookingHorizon;
    });
    debugLogger(`Filtered allowedOffsets within booking horizon: ${allowedOffsets.join(", ")}`);
    // Fetch global flight network once
    const routesData = await fetchDestinations();
    const results = [];
    let directCounter = 0;
    
    for (const origin of origins) {
      for (const destination of destinations) {
        if (origin === destination) continue;
        if (isCancelled()) break;

        if (isDateAvailableForSegment(origin, destination, selectedDate)) {
          const cacheKey = getUnifiedCacheKey(origin, destination, selectedDate);
          let flights = await getCachedResults(cacheKey);
          if (!flights) {
            try {
              flights = await checkRouteSegment(origin, destination, selectedDate);
              flights = flights.map(unifyRawFlight);
              debugLogger(`   Fetched ${flights.length} flights from server for ${origin} -> ${destination} on ${selectedDate}`);
              await setCachedResults(cacheKey, flights);
              } catch (error) {
                console.error(`Error loading flights: ${error.message}`);
                flights = [];
              }
          }
          flights = flights.map(unifyRawFlight);
          for (const flight of flights) {
            if (shouldAppend) appendRouteToDisplay(flight);
            results.push(flight);
            
            directCounter++;
            updateProgress(directCounter, origins.length * destinations.length, `Direct routes`);
          }
        }
      }
    }
    //
    // 1) Build a map: origin → Set of valid first-leg airports (B)
    //
    const firstLegMap = new Map();
    for (const origin of origins) {
      const bs = new Set();
      // first leg must depart on selectedDate
      for (const route of routesData) {
        const dep = typeof route.departureStation === "object"
          ? route.departureStation.id
          : route.departureStation;
        if (dep !== origin) continue;

        for (const arrival of route.arrivalStations || []) {
          const arr = typeof arrival === "object" ? arrival.id : arrival;
          if (isDateAvailableForSegment(origin, arr, selectedDate)) {
            bs.add(arr);
          }
        }
      }
      firstLegMap.set(origin, bs);
      debugLogger(`[DEBUG] first-leg options for ${origin}:`, Array.from(bs));
    }

    //
    // 2) Build a map: destination → Set of valid second-leg airports (N)
    //
    const secondLegMap = new Map();
    for (const destination of destinations) {
      const ns = new Set();
      for (const offset of allowedOffsets) {
        const date = addDaysUTC(new Date(`${selectedDate}T00:00:00Z`), offset)
          .toISOString()
          .slice(0, 10);

        for (const route of routesData) {
          const dep = typeof route.departureStation === "object"
            ? route.departureStation.id
            : route.departureStation;

          for (const arrival of route.arrivalStations || []) {
            const arr = typeof arrival === "object" ? arrival.id : arrival;
            if (arr === destination && isDateAvailableForSegment(dep, arr, date)) {
              ns.add(dep);
            }
          }
        }
      }
      secondLegMap.set(destination, ns);
      debugLogger(`[DEBUG] second-leg options for ${destination}:`, Array.from(ns));
    }

    //
    // 3) Build a flat list of all candidate chains {origin, B, N, destination}
    //
    const candidates = [];
    for (const origin of origins) {
      const Bs = Array.from(firstLegMap.get(origin) || []);
      for (const destination of destinations) {
        const Ns = Array.from(secondLegMap.get(destination) || []);
        for (const B of Bs) {
          // filter N by distance <= radius
          const validNs = Ns.filter(N => {
            if (B === N) return true;
            const locB = airportLookup[B];
            const locN = airportLookup[N];
            return (
              locB &&
              locN &&
              haversineDistance(
                locB.latitude,
                locB.longitude,
                locN.latitude,
                locN.longitude
              ) <= connectionRadiusKm
            );
          });
          for (const N of validNs) {
            candidates.push({ origin, B, N, destination });
          }
        }
      }
    }

    const totalRoutes = candidates.length;
    let routeCounter = 0;

    //
    // 4) Smart-grouped iteration: group by whichever leg covers more candidates per
    //    unique pair, so one empty-leg result eliminates the most follow-up fetches.
    //
    const byFirstLeg = new Map();
    const bySecondLeg = new Map();
    for (const cand of candidates) {
      const k1 = `${cand.origin}|${cand.B}`;
      const k2 = `${cand.N}|${cand.destination}`;
      if (!byFirstLeg.has(k1)) byFirstLeg.set(k1, []);
      byFirstLeg.get(k1).push(cand);
      if (!bySecondLeg.has(k2)) bySecondLeg.set(k2, []);
      bySecondLeg.get(k2).push(cand);
    }

    // Choose the grouping whose keys cover more candidates on average.
    const groupByFirst = byFirstLeg.size <= bySecondLeg.size;

    if (groupByFirst) {
      for (const [, group] of byFirstLeg) {
        if (isCancelled()) break;
        const { origin, B } = group[0];
        const flights1 = await loadFlights(origin, B, selectedDate, [0]);
        if (!flights1.length) {
          routeCounter += group.length;
          updateProgress(routeCounter, totalRoutes, `No flights: ${origin} → ${B}`);
          continue;
        }
        // Deduplicate second legs within this first-leg group.
        const bySecondInGroup = new Map();
        for (const cand of group) {
          const k2 = `${cand.N}|${cand.destination}`;
          if (!bySecondInGroup.has(k2)) bySecondInGroup.set(k2, []);
          bySecondInGroup.get(k2).push(cand);
        }
        for (const [, subGroup] of bySecondInGroup) {
          if (isCancelled()) break;
          const { N, destination } = subGroup[0];
          routeCounter += subGroup.length;
          updateProgress(routeCounter, totalRoutes,
            N !== B
              ? `Checking route: ${origin} → ${B} ⇄ ${N} → ${destination}`
              : `Checking route: ${origin} → ${B} → ${destination}`
          );
          const flights2 = await loadFlights(N, destination, selectedDate, allowedOffsets);
          if (!flights2.length) continue;
          debugLogger(`Found ${flights1.length} for ${origin}→${B} and ${flights2.length} for ${N}→${destination}`);
          combineAndAppend(flights1, flights2, minConnection, maxConnection, results, shouldAppend);
        }
      }
    } else {
      for (const [, group] of bySecondLeg) {
        if (isCancelled()) break;
        const { N, destination } = group[0];
        const flights2 = await loadFlights(N, destination, selectedDate, allowedOffsets);
        if (!flights2.length) {
          routeCounter += group.length;
          updateProgress(routeCounter, totalRoutes, `No flights: ${N} → ${destination}`);
          continue;
        }
        // Deduplicate first legs within this second-leg group.
        const byFirstInGroup = new Map();
        for (const cand of group) {
          const k1 = `${cand.origin}|${cand.B}`;
          if (!byFirstInGroup.has(k1)) byFirstInGroup.set(k1, []);
          byFirstInGroup.get(k1).push(cand);
        }
        for (const [, subGroup] of byFirstInGroup) {
          if (isCancelled()) break;
          const { origin, B } = subGroup[0];
          routeCounter += subGroup.length;
          updateProgress(routeCounter, totalRoutes,
            N !== B
              ? `Checking route: ${origin} → ${B} ⇄ ${N} → ${destination}`
              : `Checking route: ${origin} → ${B} → ${destination}`
          );
          const flights1 = await loadFlights(origin, B, selectedDate, [0]);
          if (!flights1.length) continue;
          debugLogger(`Found ${flights1.length} for ${origin}→${B} and ${flights2.length} for ${N}→${destination}`);
          combineAndAppend(flights1, flights2, minConnection, maxConnection, results, shouldAppend);
        }
      }
    }

    debugLogger(
      `[DEBUG] airport-change search found ${results.length} routes:`,
      results.map(r => r.key).join(", ")
    );
    return results;
  }

// ──────────────── 1) Helper: nearby‑airport lookup ────────────────
/**
 * Returns every airport code (from allCodes) within radiusKm of baseCode.
 */
  function findNearbyAirports(baseCode, radiusKm, allCodes) {
    const base = airportLookup[baseCode];
    if (!base) return [];
    return allCodes.filter(code => {
      if (code === baseCode) return false;
      const loc = airportLookup[code];
      if (!loc) return false;
      const d = haversineDistance(
        base.latitude, base.longitude,
        loc.latitude,  loc.longitude
      );
      return d <= radiusKm;
    });
  }

  // ────────── 2) processTwoStopsWithAirportChange ──────────
  async function processTwoStopsWithAirportChange(
    origins,
    destinations,
    selectedDate,
    minConnection,
    maxConnection,
    connectionRadiusKm,
    allowedOffsets,
    shouldAppend = true
  ) {
    const results    = [];
    const routesData = await fetchDestinations();

    // ─── collect every code in the network ───
    const allCodes = Array.from(new Set(
      routesData.map(r => (
        typeof r.departureStation === 'object'
          ? r.departureStation.id
          : r.departureStation
      ))
    ));

    // ─── 2a) build direct‑map & mid‑map for origins ───
    const directMap = new Map(); // O → [A₁, A₂, …] (only where O→A exists)
    const midMap    = new Map(); // O → [ {code: A, via: A}, {code: N, via: A}, … ]
    for (let O of origins) {
      if (isCancelled()) break;
      // find A's where O→A on selectedDate
      const As = routesData
        .filter(r => {
          const dep = typeof r.departureStation==='object'
            ? r.departureStation.id
            : r.departureStation;
          return dep === O
            && (r.arrivalStations || []).some(st => {
                const id = typeof st==='object' ? st.id : st;
                return isDateAvailableForSegment(O, id, selectedDate);
              });
        })
        .flatMap(r => (r.arrivalStations || []).map(st => typeof st==='object' ? st.id : st))
        .filter((v,i,a)=>a.indexOf(v)===i);

      directMap.set(O, As);

      // now build mids = each A itself + its neighbors within radius
      const mids = [];
      for (let A of As) {
        mids.push({ code: A, via: A });
        for (let neigh of findNearbyAirports(A, connectionRadiusKm, allCodes)) {
          mids.push({ code: neigh, via: A });
        }
      }
      midMap.set(O, mids);
    }

    // ─── 2b) build direct‑map & mid‑map for destinations ───
    const directDestMap = new Map(); // D → [B₁, B₂,…] where B→D exists
    const midDestMap    = new Map(); // D → [ {code: B, via: B}, {code: N, via: B}, … ]
    for (let D of destinations) {
      if (isCancelled()) break;
      const Bs = routesData
        .filter(r => {
          const dep = typeof r.departureStation==='object'
            ? r.departureStation.id
            : r.departureStation;

          return dep !== D
            && (r.arrivalStations || []).some(st => {
                const id = typeof st==='object' ? st.id : st;
                if (id !== D) return false;
                return allowedOffsets.some(offset => {
                  const date = addDaysUTC(
                    new Date(`${selectedDate}T00:00:00Z`),
                    offset
                  )
                    .toISOString()
                    .slice(0, 10);
                  return isDateAvailableForSegment(dep, D, date);
                });
              });
        })
        .map(r => typeof r.departureStation==='object' ? r.departureStation.id : r.departureStation)
        .filter((v,i,a)=>a.indexOf(v)===i);

      directDestMap.set(D, Bs);

      const mids = [];
      for (let B of Bs) {
        if (isCancelled()) break;
        mids.push({ code: B, via: B });
        for (let neigh of findNearbyAirports(B, connectionRadiusKm, allCodes)) {
          mids.push({ code: neigh, via: B });
        }
      }
      midDestMap.set(D, mids);
    }

    // ─── 3) build all {O,A,X,B,D} candidates ───
    let candidates = [];
    for (let O of origins) {
      for (let D of destinations) {
        if (isCancelled()) break;
        const midsO = midMap.get(O)    || [];
        const midsD = midDestMap.get(D) || [];
        
        for (let { code: X, via: A } of midsO) {
          for (let { code: Y, via: B } of midsD) {
            if (origins.includes(Y) || origins.includes(B) || destinations.includes(X) || destinations.includes(A)) {
              continue;
            }
            // require that X→Y is either a real flight or within radius foot‑transfer
            const routeXY   = routeCatalog.getRoute(X, Y);
            const locX      = airportLookup[X];
            const locY      = airportLookup[Y];

            const coordsValid = locX && locY && 
                                locX.latitude !== undefined && locX.longitude !== undefined &&
                                locY.latitude !== undefined && locY.longitude !== undefined;
                          
            let withinRad = false;
            let distance = 0;
              if (coordsValid) {
                distance = haversineDistance(
                  locX.latitude, locX.longitude,
                  locY.latitude, locY.longitude
                );
                withinRad = distance <= connectionRadiusKm;
              }

            if (X !== Y && !routeXY && !withinRad) {
            continue;
            }
            candidates.push({ O, A, X, B, Y, D });
          }
        }
      }
    }
    console.table(candidates);

    // ─── 3.1) preliminary flight‑dates filter ───
    const todayUTC      = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z");
    const bookingHorizon= addDaysUTC(todayUTC, 3);
    const totalCands    = candidates.length;
    // keep only those where each *real* flight leg has at least one flightDate
    candidates = candidates.filter(({ O, A, X, B, Y, D }) => {
      // leg1, leg2, leg3 chains
      const legs = [
        [O, A],  // first real flight
        [X, Y],  // second real flight (after transfer)
        [B, D],  // third real flight
      ];

      // every leg must pass candidateHasValidFlightDates
      return legs.every(pair => 
        candidateHasValidFlightDates(
          pair,
          routesData,
          selectedDate,
          bookingHorizon,
          allowedOffsets
        )
      );
    });

    debugLogger(
      `[DEBUG] After real‑flight date‑filter: ${candidates.length} of ${totalCands} remain`
    );
    console.table(candidates);


    // ─── 4) Smart-grouped load & stitch: check outer legs once per unique pair,
    //        skipping the inner legs entirely when an outer leg has no flights.
    //        Group by whichever outer leg has fewer unique keys (more candidates per
    //        key → bigger saving per empty result).
    const totalCandidates = candidates.length;
    let processedCandidates = 0;

    const byOuterFirst = new Map();   // keyed by (O,A)
    const byOuterThird = new Map();   // keyed by (B,D)
    for (const cand of candidates) {
      const k1 = `${cand.O}|${cand.A}`;
      const k3 = `${cand.B}|${cand.D}`;
      if (!byOuterFirst.has(k1)) byOuterFirst.set(k1, []);
      byOuterFirst.get(k1).push(cand);
      if (!byOuterThird.has(k3)) byOuterThird.set(k3, []);
      byOuterThird.get(k3).push(cand);
    }
    // Outer group with fewer unique keys has more candidates per key → check it first.
    const outerGroupByFirst = byOuterFirst.size <= byOuterThird.size;
    const outerMap   = outerGroupByFirst ? byOuterFirst : byOuterThird;
    const innerKeyFn = outerGroupByFirst
      ? cand => `${cand.B}|${cand.D}`
      : cand => `${cand.O}|${cand.A}`;

    for (const [, outerGroup] of outerMap) {
      if (isCancelled()) break;

      // Fetch the outer leg (leg1 or leg3 depending on which grouping we chose).
      let fOuter;
      if (outerGroupByFirst) {
        const { O, A } = outerGroup[0];
        fOuter = await loadFlights(O, A, selectedDate, [0]);
      } else {
        const { B, D } = outerGroup[0];
        fOuter = await loadFlights(B, D, selectedDate, allowedOffsets);
      }
      if (!fOuter.length) {
        processedCandidates += outerGroup.length;
        const label = outerGroupByFirst
          ? `${outerGroup[0].O}→${outerGroup[0].A}` : `${outerGroup[0].B}→${outerGroup[0].D}`;
        updateProgress(processedCandidates, totalCandidates, `No flights: ${label}`);
        continue;
      }

      // Within the outer group, group by the inner outer leg (leg3 or leg1).
      const innerMap = new Map();
      for (const cand of outerGroup) {
        const k = innerKeyFn(cand);
        if (!innerMap.has(k)) innerMap.set(k, []);
        innerMap.get(k).push(cand);
      }

      for (const [, innerGroup] of innerMap) {
        if (isCancelled()) break;

        let fInner;
        if (outerGroupByFirst) {
          const { B, D } = innerGroup[0];
          fInner = await loadFlights(B, D, selectedDate, allowedOffsets);
        } else {
          const { O, A } = innerGroup[0];
          fInner = await loadFlights(O, A, selectedDate, [0]);
        }
        if (!fInner.length) {
          processedCandidates += innerGroup.length;
          continue;
        }

        // Resolve f1 and f3 based on which grouping is active.
        const f1 = outerGroupByFirst ? fOuter : fInner;
        const f3 = outerGroupByFirst ? fInner : fOuter;

        // Group remaining candidates by middle leg (X, Y).
        const byMidLeg = new Map();
        for (const cand of innerGroup) {
          const km = `${cand.X}|${cand.Y}`;
          if (!byMidLeg.has(km)) byMidLeg.set(km, []);
          byMidLeg.get(km).push(cand);
        }

        for (const [, midGroup] of byMidLeg) {
          if (isCancelled()) break;
          const { O, A, X, B, Y, D } = midGroup[0];
          processedCandidates += midGroup.length;
          const progressMessage =
            A === X && B === Y ? `Checking route: ${O} → ${A} → ${B} → ${D}` :
            A !== X && B === Y ? `Checking route: ${O} → ${A} ⇄ ${X} → ${B} → ${D}` :
            A === X && B !== Y ? `Checking route: ${O} → ${A} → ${Y} ⇄ ${B} → ${D}` :
            `Checking route: ${O} → ${A} ⇄ ${X} → ${Y} ⇄ ${B} → ${D}`;
          updateProgress(processedCandidates, totalCandidates, progressMessage);

          const f2 = await loadFlights(X, Y, selectedDate, allowedOffsets);
          if (!f2.length) continue;

          for (let flight1 of f1) {
            for (let flight2 of f2) {
              const gap1 = (flight2.calculatedDuration.departureDate
                          - flight1.calculatedDuration.arrivalDate) / 60000;
              if (gap1 < minConnection || gap1 > maxConnection) continue;
              for (let flight3 of f3) {
                const gap2 = (flight3.calculatedDuration.departureDate
                            - flight2.calculatedDuration.arrivalDate) / 60000;
                if (gap2 < minConnection || gap2 > maxConnection) continue;

                debugLogger(`    ✓ valid: [${flight1.key}]→[${flight2.key}]→[${flight3.key}]`);

                const dep  = flight1.calculatedDuration.departureDate;
                const arr  = flight3.calculatedDuration.arrivalDate;
                const depUtc = flight1.departureDateUtc;
                const arrUtc = flight3.arrivalDateUtc;
                const totalDuration = Math.round((arrUtc - depUtc) / 60000);
                const locA = airportLookup[flight1.arrivalStation];
                const locBNode = airportLookup[flight2.departureStation];
                const locC = airportLookup[flight2.arrivalStation];
                const locD = airportLookup[flight3.departureStation];
                const conn = Math.round(gap1 + gap2);
                const changeDistanceKmOne = locA && locBNode
                  ? Math.round(haversineDistance(locA.latitude, locA.longitude, locBNode.latitude, locBNode.longitude))
                  : null;
                const changeDistanceKmTwo = locC && locD
                  ? Math.round(haversineDistance(locC.latitude, locC.longitude, locD.latitude, locD.longitude))
                  : null;
                const agg = {
                  key: flight1.key + " | " + flight2.key + " | " + flight3.key,
                  stops: "2 transfers",
                  totalConnectionTime: conn,
                  segments: [flight1, flight2, flight3],
                  airportChangeOne: {
                    from: flight1.arrivalStation,
                    to: flight2.departureStation,
                    distanceKm: changeDistanceKmOne
                  },
                  airportChangeTwo: {
                    from: flight2.arrivalStation,
                    to: flight3.departureStation,
                    distanceKm: changeDistanceKmTwo
                  },
                  calculatedDuration: {
                    hours: Math.floor(totalDuration / 60),
                    minutes: totalDuration % 60,
                    totalMinutes: totalDuration,
                    departureDate: dep,
                    arrivalDate: arr
                  },
                  formattedFlightDate: formatFlightDateCombined(dep, arr),
                  currency: flight1.currency,
                  displayPrice: flight1.displayPrice,
                  priceTag: flight1.priceTag,
                  route: [flight1.departureStationText, flight3.arrivalStationText]
                };
                if (shouldAppend) appendRouteToDisplay(agg);
                results.push(agg);
              }
            }
          }
        }
      }
    }

    return results;
  }


  async function loadFlights(dep, arr, baseDate, offsets) {
    const out = [];
    for (const off of offsets) {
      const date = addDaysUTC(new Date(`${baseDate}T00:00:00Z`), off).toISOString().slice(0,10);
      if (arr == null) {
        debugLogger(`Bad params to loadFlights(): ${dep}→${arr}`);
        continue;
      }
      let segs = await getCachedResults(`${dep}-${arr}-${date}`);

      if (!Array.isArray(segs)) {
        try {
          const result = await checkRouteSegment(dep, arr, date);
          segs = Array.isArray(result) 
            ? result.map(unifyRawFlight) 
            : [];
          await setCachedResults(`${dep}-${arr}-${date}`, segs);
        } catch (error) {
          console.error(`Error loading flights: ${error.message}`);
          segs = [];
        }
      }
      out.push(...segs);
    }
    return out;
  }


  function combineAndAppend(firstFlights, secondFlights, minConnection, maxConnection, results, shouldAppend) {
    const combined = combineOneStopFlights(firstFlights, secondFlights, {
      minConnection,
      maxConnection,
      airportLookup
    });
    if (shouldAppend) combined.forEach(appendRouteToDisplay);
    results.push(...combined);
  }


  async function searchConnectingRoutes(
    origins,
    destinations,
    selectedDate,
    maxTransfers,
    shouldAppend = true,
    skipProgress = false
  ) {
    debugLogger("Starting searchConnectingRoutes");
    const routesData = await fetchDestinations();
    const graph = buildGraph(routesData);
  
    // 1) Load user settings
    const connectionSettings = getSettings();
    const minConnection = connectionSettings.minConnectionTime;
    const maxConnection = connectionSettings.maxConnectionTime;
    const stopoverText       = getStopoverText();
    const connectionRadius = connectionSettings.connectionRadius;
    const allowChangeAirport = connectionSettings.allowChangeAirport;
  
    debugLogger(
      `[DEBUG] searchConnectingRoutes → stopover="${stopoverText}",`,
      `allowChangeAirport=${allowChangeAirport},`,
      `connectionRadius=${connectionRadius}km, maxTransfers=${maxTransfers}`,
      `minConnection=${minConnection} min, maxConnection=${maxConnection} min`
    );
  
    const allowOvernight = stopoverText === "One stop or fewer (overnight)";
    debugLogger(
      `Stopover setting: ${stopoverText} (${allowOvernight ? "overnight allowed" : "day-only"})`
    );
  
    // 2) Compute booking horizon (today + 3 days)
    const baseDateUTC    = new Date(selectedDate + "T00:00:00Z");
    const todayUTC       = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z");
    const bookingHorizon = addDaysUTC(todayUTC, 3);
    debugLogger(`Booking horizon set to: ${bookingHorizon.toISOString().slice(0,10)}`);
  
    // 3) Expand "ANY" destinations
    let destinationList = [];
    if (destinations.length === 1 && destinations[0] === "ANY") {
      const allDest = new Set();
      routesData.forEach(r => {
        (r.arrivalStations || []).forEach(s => {
          allDest.add(typeof s === "object" ? s.id : s);
        });
      });
      destinations = Array.from(allDest);
      destinationList = destinations;
      debugLogger(`Expanded ANY → ${destinationList.join(", ")}`);
    } else {
      destinationList = destinations;
    }
  
    // 4) Build allowedOffsets
    const maxDayOffset = Math.floor(maxConnection / (60*24)); // =1
    let allowedOffsets = [];
    if (maxTransfers > 1) {
      // multi-stop: from day 0 up to bookingHorizon
      for (let d = 0; ; d++) {
        const dDate = addDaysUTC(baseDateUTC, d);
        if (dDate > bookingHorizon) break;
        allowedOffsets.push(d);
      }
    } else {
      // one-stop: day 0 always
      allowedOffsets = [0];
      if (allowOvernight) {
        for (let d = 1; d <= maxDayOffset; d++) {
          allowedOffsets.push(d);
        }
      }
    }
    debugLogger(`Allowed offsets: ${allowedOffsets.join(", ")}`);
  
    // 5) Airport-change shortcut?
    const switchableForTwoStops = (
      maxTransfers === 2 &&
      allowChangeAirport &&
      connectionRadius > 0
    );
    
    if (switchableForTwoStops) {
      const results = [];
        debugLogger("Searching one-stop flights");
        const oneStopResults = await processOneStopWithAirportChange(
        origins,
        destinations,
        selectedDate,
        minConnection,
        maxConnection,
        connectionRadius,
        allowedOffsets,
        shouldAppend,
        true // skipProgress
      );
      results.push(...oneStopResults || []);
      if (isCancelled()) return results;

      debugLogger("Airport-change mode ON: delegating to processTwoStopsWithAirportChange");
      const twoStopResults = await processTwoStopsWithAirportChange(
        origins,
        destinations,
        selectedDate,
        minConnection,
        maxConnection,
        connectionRadius,
        allowedOffsets,
        shouldAppend
      );
      results.push(...twoStopResults || []);
      debugLogger(`Found ${results.length} two-stop routes with airport change`);
      return results;
    }
    const switchableForOneStop = (
      maxTransfers === 1 &&
      (stopoverText === "One stop or fewer"
        || stopoverText === "One stop or fewer (overnight)")
      && allowChangeAirport
      && connectionRadius > 0
    );
    if (switchableForOneStop) {
      debugLogger("Airport-change mode ON: delegating to processOneStopWithAirportChange");
      // **Pass allowedOffsets** into your new function
      const results = await processOneStopWithAirportChange(
        origins,
        destinations,
        selectedDate,
        minConnection,
        maxConnection,
        connectionRadius,
        allowedOffsets,
        true
      );
      debugLogger(`Found ${results.length} routes with airport change`);
      return results;
    }
  
    // 6) Build all candidate chains via DFS
    let candidateRoutes = findCandidateRoutes(graph, origins, destinationList, maxTransfers);
    debugLogger(`Total candidate routes found: ${candidateRoutes.length}`);
  
    // 7) Preliminary flight-dates filter
    candidateRoutes = candidateRoutes.filter(chain =>
      candidateHasValidFlightDates(chain, routesData, selectedDate, bookingHorizon, allowedOffsets)
    );
    debugLogger(`After date check, ${candidateRoutes.length} candidates remain`);
  
    // 8) Process each candidate with your existing processSegment
    let processed = 0;
    const total = candidateRoutes.length;
    if (!skipProgress) updateProgress(0, total, "Processing routes");
  
    const aggregatedResults = [];
    for (const candidate of candidateRoutes) {
      if (isCancelled()) break;
      processed++;
      if (!skipProgress) updateProgress(processed, total, `Checking ${candidate.join("→")}`);
  
      const chains = await processSegment(
        candidate,
        0,
        baseDateUTC,
        null,                      // no previous flight
        bookingHorizon,
        minConnection,
        maxConnection,
        allowedOffsets[allowedOffsets.length - 1], // max offset
        selectedDate,
        routesData
      );
  
      for (const chain of chains) {
        // Build your aggregated route object exactly as before…
        const firstDep = chain[0].calculatedDuration.departureDate;
        const firstDepUtc = chain[0].departureDateUtc;
        const lastArr  = chain[chain.length-1].calculatedDuration.arrivalDate;
        const lastArrUtc  = chain[chain.length-1].arrivalDateUtc;
        const totalMins = Math.round((lastArrUtc - firstDepUtc)/60000);
        const totalConn = chain.slice(0,-1).reduce((sum, f, i) => {
          const next = chain[i+1];
          return sum + Math.round((next.calculatedDuration.departureDateUtc - f.calculatedDuration.arrivalDateUtc)/60000);
        }, 0);
  
        const aggregatedRoute = {
          key: chain.map(f => f.key).join(" | "),
          fareSellKey: chain[0].fareSellKey,
          departure: chain[0].departure,
          arrival: chain[chain.length-1].arrival,
          departureStation: chain[0].departureStation,
          departureStationText: chain[0].departureStationText,
          arrivalStation: chain[chain.length-1].arrivalStation,
          arrivalStationText: chain[chain.length-1].arrivalStationText,
          departureDate: chain[0].departureDate,
          arrivalDate: chain[chain.length-1].arrivalDate,
          stops: `${chain.length-1} transfer${chain.length-1===1?"":"s"}`,
          totalConnectionTime: totalConn,
          segments: chain,
          calculatedDuration: {
            hours: Math.floor(totalMins/60),
            minutes: totalMins%60,
            totalMinutes: totalMins,
            departureDate: firstDep,
            arrivalDate: lastArr
          },
          formattedFlightDate: formatFlightDateCombined(firstDep, lastArr),
          currency: chain[0].currency,
          displayPrice: chain[0].displayPrice,
          priceTag: chain[0].priceTag,
          route: [chain[0].departureStationText, chain[chain.length-1].arrivalStationText]
        };
  
        if (shouldAppend) appendRouteToDisplay(aggregatedRoute);
        aggregatedResults.push(aggregatedRoute);
      }
    }
  
    return aggregatedResults;
  }

  return searchConnectingRoutes;
}
