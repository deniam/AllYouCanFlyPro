# All You Can Fly Pro

All You Can Fly Pro is a browser extension for Wizz Air All You Can Fly subscribers. It searches direct and connecting availability, supports multiple airports and dates, round trips, custom airport groups, CSV export, and continuation to booking.

The primary target is desktop Google Chrome. The unpacked extension is also tested manually in Orion on iPhone and iPad. Orion's WebExtensions support is incomplete, so runtime dependencies are packaged locally and platform access is isolated behind compatibility adapters.

## Architecture

The runtime uses plain JavaScript with JSDoc and native ES modules. There is no production bundler and npm is not required to run the extension.

```text
index.html                    semantic UI shell
assets/css/app.css            application styles
src/app/main.js               only extension-page entry point
src/app/app-controller.js     idempotent mount lifecycle
src/app/state.js              session state and search cancellation
src/domain/                   routes, airports, dates and flight normalization
src/domain/search/            candidates, direct search, connections and orchestration
src/infrastructure/           WebExtensions, Dexie, cache, settings, throttle, Multipass client
src/ui/                       focused UI controllers and renderers
src/background.js             classic MV3 service worker
src/content-parsers.js        isolated Multipass page parsers
src/content.js                classic Multipass content script
src/data/                     packaged airport and route data
tests/                        unit/integration tests and anonymized fixtures
```

Important boundaries:

- Domain modules do not access the DOM, `chrome.*`, storage, or IndexedDB.
- Extension-page platform calls go through `extension-api.js`.
- `background.js` and `content.js` remain classic scripts for Orion compatibility.
- Routes are loaded from a validated GitHub Pages dataset, cached in `chrome.storage.local`, and indexed once in memory. The packaged dataset is a lazy offline fallback.
- IndexedDB `FlightSearchCache/cache` and existing localStorage keys remain backward compatible with 3.5.0.
- Search cancellation uses `AbortController`; throttle, retry, tab waits and session discovery have finite lifetimes.

## Development

Node.js is used only for linting, tests and release checks.

```bash
npm install
npm test
npm run lint
npm run check
npm run package
```

`npm run check` performs syntax checks, ESLint, Vitest, manifest asset validation, duplicate-ID detection and remote-script checks. `npm run package` runs the checks and creates `extension.zip` from an explicit runtime allowlist. It does not modify or remove source files.

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the repository root.
5. Pin the extension and click its toolbar action.
6. Log in to the Wizz Air Multipass page if prompted.

For Orion on iOS/iPadOS, enable extension support in Orion, import the unpacked/archive form supported by the tested Orion version, grant access to `multipass.wizzair.com`, and perform the complete manual matrix below on a real device.

## Updating route data

1. Run the sibling `Wizz Air Routes And Dates Scanner` project with the required `--from`/`--to` range.
2. Review its topology and validation report, then rerun with `--publish` to update the `routes-data` GitHub Pages branch.
3. The extension downloads a changed dataset manifest on startup, validates the JSON and SHA-256, and replaces its single local cache entry.
4. Update `src/data/routes.js` separately only when refreshing the packaged offline fallback for an application release.
5. Run `npm run check` and test airport resolution, date filtering, Anywhere, connecting routes, offline cache and packaged fallback behavior.

## Manual platform matrix

Run [the smoke checklist](docs/manual-smoke-checklist.md) on:

- current Chrome desktop;
- current Orion on iPhone;
- current Orion on iPad;
- clean installation;
- update over 3.5.0 with existing settings, custom groups and cache.

Automated tests never call the live Wizz Air API. Authenticated availability and booking continuation must be tested manually with the minimum practical number of requests.

## Changelog

### Version 4.0.0 — August 31, 2026

- Rebuilt the project structure into a modular, layered architecture, separating application state, domain logic, infrastructure services and UI components.
- Introduced a search orchestration layer for direct, connecting and round-trip searches, with normalized flight data and shared result matching.
- Added streamed round-trip results and improved result sorting and rendering, including cached connecting-flight cards.
- Improved round-trip caching by selecting uncached paired dates and warming reverse-segment cache entries when possible.
- Added adaptive request concurrency, centralized request throttling, configurable concurrency limits and an availability-request timeout.
- Improved Multipass authentication, empty or malformed response handling, session state and opening Multipass in the current browser tab.
- Added remote route-dataset loading with manifest and checksum validation, local cache support and a packaged offline fallback.
- Added configurable dark mode, improved the mobile flight-card layout and fixed weekend date-selection and live-search issues.
- Added route-exclusion persistence and improved cache/settings storage while preserving compatibility with existing data.
- Added automated unit and integration tests, syntax checks, extension validation and a manual smoke-test checklist.

### Version 3.6.0 — August 29, 2026

- Updated `routesData` with schedule until 2026-10-31.

### Version 3.5.0 — July 1, 2026

- Improved search speed for connecting flights: the search algorithm for 1-stop and 2-stop flights now skips unnecessary checks when a key part of the route has no available flights.
- Added Custom Airport Groups in Options, allowing users to create and save airport groups and search them like built-in city groups.

### Version 3.4.4 — June 30, 2026

- Updated `routesData` with schedule until 2026-08-30.

### Version 3.4.3 — April 27, 2026

- Updated `routesData` with schedule until 2026-06-30.

## Release checklist

1. Confirm the manifest version and changelog.
2. Run `npm ci` and `npm run check` from a clean checkout.
3. Load the repository as an unpacked Chrome extension and complete the Chrome smoke test.
4. Complete a separate real-device Orion iOS/iPadOS regression pass.
5. Run `npm run package`.
6. Inspect `extension.zip`: it must contain only manifest, index, runtime assets, `src`, README and LICENSE.
7. Confirm there are no unhandled Promise rejections in the page, content script or service-worker logs.

## Privacy and disclaimer

The extension stores settings and cached search responses locally. It does not operate an analytics backend. All You Can Fly Pro is an independent project and is not affiliated with Wizz Air or another airline.

Licensed under the MIT License. Contributions are welcome at [GitHub](https://github.com/deniam/AllYouCanFlyPro).
