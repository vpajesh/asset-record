# Asset Record – web app (iPhone, Android, PC) + App Store project

One code base, SAP Fiori (Horizon) design. It follows the same rules as `Asset_Record.xlsm`:
- `src/logic.js` ports `SaveLocationRow`, `GetNextFLCode` and `WriteAssetDataToRow`.
- It is tested against all 1,126 workbook locations (`node test/logic.test.js <seed.json>`).
- Its export ZIP has the same layout as the Android app's, so `excel/modAppSync.bas` → `ImportFromApp` works unchanged.

| Folder | What |
|---|---|
| `src/` | `logic.js` (rules), `app.js` (screens, offline storage, export), `styles.css` (Fiori look) |
| `tools/build.py` | Builds `dist/` from `src/` |
| `dist/web/` | **Installable app**: upload this folder to any HTTPS host |
| `native/` | Capacitor project: `ios/` (Xcode, App Store) and `android/` (Play Store) |

Your workbook data is **not** inside the app. Each device loads it from the master JSON that `ExportMasterForApp` creates. The built-in demo has only Class&Units codes and an invented DEMO facility.

## 1. Use it on iPhone, Android and PC (no store needed)

1. Host `dist/web/`. It's static files only, for example:
   - a **Render Static Site**: publish directory `dist/web`, no build command
   - GitHub Pages
   - any company HTTPS server
2. Install it:
   - **iPhone/iPad:** open the URL in Safari → Share → **Add to Home Screen**.
   - **Android:** open it in Chrome → menu → **Install app**.
   - **PC:** open it in Edge or Chrome → the install icon in the address bar. Or just use it in the browser.
3. First run: tap **Load master file…** and pick the JSON from `ExportMasterForApp`. Or tap **Try demo data** (user `demo`, ID `1`, password `demo`).

It works offline after the first load. Records stay on the device until you export them. Install the app to the home screen: iOS can clear browser data for sites that aren't installed and go unused for weeks.

## 2. App Store (iPhone) – needs a Mac

Requirements:
- A Mac with Xcode 16 or later
- An Apple Developer Program membership (USD 99/year)
- Node 18 or later

```
python3 tools/build.py <seed.json>      # rebuild dist/web after any change
cd native
npm install
npm run sync                            # copies dist/web, wires plugins (Filesystem, Share)
npx cap open ios                        # opens Xcode
```

In Xcode:
1. App target → Signing & Capabilities → choose your Team.
2. Change the Bundle Identifier if `com.assetrecord.app` is taken.
3. Product → **Archive** → Distribute App → **App Store Connect**.
4. Test it with **TestFlight**, then submit it for review.

Notes:
- **Staff-only app:** Apple's review often rejects login-only internal tools from the public App Store. Use **TestFlight**, or a **Custom App** through Apple Business Manager (private distribution to your organisation).
- **Review login:** give Apple the demo login (`demo` / `1` / `demo`) in the review notes.
- **Camera and photo permissions:** the texts Apple requires are already in `native/ios/App/App/Info.plist`.
- **Export:** in the native app, export uses the iOS share sheet. From there, save to Files or OneDrive, or send by Mail.

The Play Store build works the same way: `npx cap open android` → Build → Generate Signed Bundle.
