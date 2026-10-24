# SAMAAN on your iPhone (native app)

The iOS app is a native shell around the same web app, the way the team's Smart Sanskriti app
was built: a WKWebView serves the bundled UI, and native plugins provide what the web view
cannot (speech recognition through Apple's Speech framework). Capacitor generates and maintains
the Xcode project in `web/ios/`.

## One-time setup (already done on this Mac)
- Xcode 26 with the iOS platform, CocoaPods not required (Swift Package Manager).
- An Apple Development signing identity for the team's Apple ID is installed.
- `web/capacitor.config.ts`, `web/ios/App/App/Info.plist` (camera, microphone, speech, location,
  motion, local-network usage strings; HTTP allowed for the LAN API during the hackathon).

## Install on the phone (5 minutes)
1. Start the API so the phone can reach it over Wi-Fi (same network as the laptop):
   ```bash
   make api-lan
   ```
2. Build the web app with the laptop's Wi-Fi address baked in and open Xcode:
   ```bash
   make ios
   ```
   (`API_URL=http://<ip>:8000 make ios` if the auto-detected address is wrong; `make ios-sync`
   rebuilds without opening Xcode.)
3. Plug the iPhone in with a cable, unlock it, tap **Trust** if asked.
4. In Xcode: select the **App** scheme and your iPhone as the destination. Under
   **Signing & Capabilities** choose your Team (personal team is fine) and, if the bundle id
   `ai.samaan.app` is taken, change it to something unique.
5. Press **Run** (⌘R). First time only: on the phone go to Settings → General → VPN & Device
   Management → trust the developer certificate, then open SAMAAN from the home screen.

A free personal team signs the app for 7 days; re-run from Xcode to renew. A paid developer
account signs for a year and allows TestFlight for the judges' phones.

## After every web change
```bash
make ios-sync     # rebuild dist/ and copy it into the iOS project
```
then Run again from Xcode. No Xcode changes are needed for UI work.

## What works natively
- Camera (Explore arrows, photo reports, contribution), compass and motion (arrow, ride mode),
  GPS, speech synthesis (Listen mode voice), and **speech recognition via the native plugin**
  (web browsers on iOS cannot do this, which is why the native shell exists).
- The app talks to `VITE_API_URL` (the laptop) over plain HTTP; Info.plist allows local
  networking. For a public demo put the API behind HTTPS and rebuild.

## Simulator
`xcodebuild -project web/ios/App/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' build`
then run from Xcode. The simulator has no camera or compass; GPS can be simulated from Xcode's
Debug → Location menu; the in-app "Simulate walk" also works.

## Android
`npx cap add android` in `web/` produces the matching Android project (needs Android Studio);
nothing in the web app changes.
