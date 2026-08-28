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
 * @property {NormalizedFlight[]=} segments
 */

/** @typedef {NormalizedFlight & {returnFlights?: NormalizedFlight[]}} SearchResult */

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
 * @property {number} requestsFrequencyMs
 * @property {number} pauseDurationSeconds
 * @property {number} cacheLifetimeHours
 * @property {boolean} debugMode
 */

export {};
