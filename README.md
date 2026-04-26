### Lifestream 

Folder containing utilities for creating the world of Lifestream.

It is an animated movie that is based in an alternate reality where leaps and bounds in technology are created underground while the world is ravaged by a gruesome virus called Black Fever. After the Black Fever era, humanity emerges from underground to a changed world with new technologies such as: Fusion energy, Synthetic Computation Brains. 

---

## 🗺️ Map Utility App

This repository includes a React-based interactive web utility to visualize and plan the geopolitical unifications during the Black Fever era. It allows selecting real-world 2025 borders and grouping them into custom 2046 nations with local persistent storage.

### Prerequisites

You must be using the **modern Node LTS version** (Node 24 as of 2026). 
If you use `nvm` (Node Version Manager), it is highly recommended to look up and install the true modern LTS version by running:
```bash
nvm install --lts
nvm use --lts
```
Alternatively, you can just run `nvm use` in this directory to automatically use the version specified in the `.nvmrc` file (currently pinned to `24`).

### Main Packages Used
- **[React](https://react.dev/) & [Vite](https://vitejs.dev/)**: Core framework and incredibly fast dev server.
- **[react-simple-maps](https://www.react-simple-maps.io/)**: SVG-based React wrapper for d3-geo used to render the interactive world map.
- **[d3-geo](https://github.com/d3/d3-geo) & [topojson-client](https://github.com/topojson/topojson-client)**: Used for projecting the map, calculating centroids, and manipulating TopoJSON (e.g., separating French Guiana dynamically).
- **[lucide-react](https://lucide.dev/)**: Modern, clean SVG icon library.

### How to Start the App
To start the local development server, run:
```bash
npm install
npm run dev
```
Then open `http://localhost:5173/` in your browser.

### How to Update
To update the underlying packages to their latest compatible minor/patch versions, run:
```bash
npm update
```
If you wish to force an update of all packages to their absolute latest versions (use with caution as breaking changes might occur), you can run:
```bash
npx npm-check-updates -u
npm install
```