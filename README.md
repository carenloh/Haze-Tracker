# Haze Tracker

A progressive web app showing Singapore's 1-hour and 24-hour PSI by region (north, south, east, west, central, plus the highest region overall), with a threshold alert.

- **Data:** NEA via data.gov.sg real-time API (`/psi` for the 24-hr PSI, `/pm25` for the 1-hr PM2.5).
  NEA does not publish an hourly PSI, so the 1-hr PSI shown is an estimate computed from the 1-hr PM2.5 using NEA's PM2.5 sub-index bands. The 24-hr PSI is the official figure.
- **Alerts:** choose a region, a reading (1-hr or 24-hr) and a threshold. A notification fires when the reading rises to or above the threshold, then re-arms once it drops back below.
  Readings are checked every 5 minutes while the app is open. Chrome on Android can also check in the background for an installed app (Periodic Background Sync, timing decided by the browser). There is no push server, so other browsers only alert while the app is open.
- **Install:** needs HTTPS. Host the folder as static files (for example GitHub Pages: Settings → Pages → deploy from `main`, root), open the site on your phone, then use "Install app" / "Add to Home Screen". On iPhone/iPad (iOS 16.4+) notifications only work from the Home Screen app.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI |
| `lib.js` | API fetching, PSI bands, 1-hr estimate, alert logic (shared by page and service worker) |
| `sw.js` | Offline shell, background checks, notification clicks |
| `manifest.webmanifest`, `icons/` | Install metadata and app icon (`icon.svg` is the source) |
| `tests/lib.test.js` | `node --test tests/lib.test.js` |
