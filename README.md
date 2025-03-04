# All You Can Fly Pro

All You Can Fly Pro is a Chrome extension that automates the search for available flight routes and provides enhanced features such as multi-connection routes, return routes, comprehensive route search, and country-based search. This extension is designed to streamline your flight search experience by offering additional functionalities not available on the original website.

## Features
- Search for available flight routes with advanced filters.
- Support for one-way and return trips.
- Options to search for routes with connections and overnight transfers.
- Customisable throttle settings to manage API requests.
- Cache functionality for improved performance.
- Responsive and user-friendly interface.
- Option to setup default airport.

### Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/deniam24/AllYouCanFlyPro.git
   ```
2. Open Google Chrome and navigate to chrome://extensions/.
3. Enable "Developer mode" in the top right corner.
4. Click "Load unpacked" and select the cloned repository folder.
### File Structure
```css
AirRoute-Navigator/
├── manifest.json
├── index.html
├── README.md
├── LICENSE
├── src/
│   ├── background.js
│   ├── content.js
│   ├── app.js
│   └── airports.js
└── assets/
    ├── css/
    │   └── tailwind_cdn_409.css
    └── icons/
        └── icon.png
```
### License
This project is licensed under the MIT License. See the LICENSE file for details.

### Contributing
Contributions are welcome! Please submit pull requests for any bug fixes or enhancements.

### Disclaimer
All You Can Fly Pro is an independent project and is not affiliated with any airline or third-party service. The extension uses data from public sources and is provided as-is without any warranty.