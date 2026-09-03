/**
 * @typedef {Object} Station
 * @property {string} id
 * @property {string} name
 * @property {string} country
 * @property {number=} longitude
 * @property {number=} latitude
 */

/**
 * @typedef {Station & {operationStartDate?: string, flightDates?: string[]}} ArrivalStation
 */

/**
 * @typedef {Object} Route
 * @property {Station|string} departureStation
 * @property {Array<ArrivalStation|string>} arrivalStations
 */

/**
 * @typedef {Object<string, *>} RawFlight
 */

/**
 * @typedef {Object} NormalizedFlight
 * @property {string} key
 * @property {string} departureStation
 * @property {string} arrivalStation
 * @property {Date} departureDateUtc
 * @property {Date} arrivalDateUtc
 * @property {{departureDate: Date, arrivalDate: Date, totalMinutes: number}} calculatedDuration
 * @property {{source: 'cache'|'network'|'snapshot', checkedAt: number|null}=} availability
 * @property {NormalizedFlight[]=} segments
 */

/** @typedef {NormalizedFlight & {returnFlights?: NormalizedFlight[]}} SearchResult */

/**
 * @typedef {Object} SearchDiagnostics
 * @property {boolean} complete
 * @property {Array<Object>} failedProbes
 * @property {number} cacheHits
 * @property {number} networkRequests
 * @property {number} prunedBranches
 * @property {number} uniquePlannedProbes
 * @property {number} uniqueResolvedProbes
 * @property {number} peakPendingProbes
 * @property {number} peakActiveProbes
 * @property {number} peakNetworkConcurrency
 * @property {number} preflightKeys
 * @property {Array<{from: number, to: number, reason: string}>} concurrencyChanges
 */

/** @typedef {SearchResult[] & {diagnostics?: SearchDiagnostics}} SearchOutcome */

/**
 * @typedef {Object} AvailabilityOutcome
 * @property {'available'|'unavailable'|'unknown'} state
 * @property {NormalizedFlight[]} flights
 * @property {'cache'|'network'|'snapshot'|'catalog'} source
 * @property {number=} checkedAt
 * @property {string=} reason
 */

/**
 * @typedef {Object} SearchRunContext
 * @property {SearchRequest} request
 * @property {Map<string, AvailabilityOutcome>} outcomesByKey
 */

/** @typedef {'idle'|'refreshing'|'unavailable'|'error'} ResultRefreshState */

/**
 * @typedef {Object} AvailabilitySegmentRequest
 * @property {string} origin
 * @property {string} destination
 * @property {string} date
 * @property {string=} arrivalDate Optional reverse-segment date for a paired RT request.
 */

/**
 * @typedef {Object} SearchRequest
 * @property {string[]} origins
 * @property {string[]} destinations
 * @property {string[]} departureDates
 * @property {string[]} returnDates
 * @property {'oneway'|'return'} tripType
 * @property {0|1|2} maxTransfers
 * @property {boolean} allowOvernight
 * @property {number} minConnectionMinutes
 * @property {number} maxConnectionMinutes
 * @property {boolean} allowAirportChange
 * @property {number} connectionRadiusKm
 * @property {number=} maxConcurrentRequests
 */

/**
 * @typedef {Object} SearchProgress
 * @property {number} current
 * @property {number} total
 * @property {string} message
 */

/**
 * @typedef {Object} CustomAirportGroup
 * @property {string} key
 * @property {string} name
 * @property {string[]} airports
 */

/**
 * @typedef {Object} StoredSettings
 * @property {number} minConnectionTime
 * @property {number} maxConnectionTime
 * @property {string} preferredAirport
 * @property {boolean} allowChangeAirport
 * @property {number} connectionRadius
 * @property {number} maxRequestsInRow
 * @property {number} pauseDurationSeconds
 * @property {number} maxConcurrentRequests
 * @property {number} cacheLifetimeHours
 * @property {boolean} debugMode
 */

export {};
