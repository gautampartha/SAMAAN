# SAMAAN on your iPhone (native app)

The iOS app is a native shell around the same web app, the way the team's Smart Sanskriti app
was built: a WKWebView serves the bundled UI, and native plugins provide what the web view
cannot (speech recognition through Apple's Speech framework). Capacitor generates and maintains
the Xcode project in `web/ios/`.

## One-time setup (already done on this Mac)
- Xcode 26 with the iOS platform and CocoaPods (`pod --version`; run pod commands with
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`). The project uses CocoaPods because the speech-recognition
  plugin ships no Swift Package manifest; with SPM it was silently left out of the app and every
  voice input failed with "voice recognition failed".
- An Apple Development signing identity for the team's Apple ID is installed.
- `web/capacitor.config.ts`, `web/ios/App/App/Info.plist` (camera, microphone, speech, location,
  motion, local-network usage strings; HTTP allowed for the LAN API during the hackathon).

## Signing (set once, 2026-10-25)
The project is signed with **Partha Gautam (Personal Team)**, team id `6K4J7A3A97`, bundle id
`ai.samaan.app`, automatic signing. The Apple ID must be signed in under Xcode → Settings →
Accounts on the building Mac. From the command line:
```bash
cd web/ios/App && LANG=en_US.UTF-8 pod install && xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination 'id=<iphone udid>' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <iphone udid> <path to App.app>
xcrun devicectl device process launch --device <iphone udid> ai.samaan.app
```
(`xcrun devicectl list devices` prints the udid.) A personal team's profile lasts 7 days.

## Reaching the API from the phone
Campus and hackathon Wi-Fi usually isolate devices, so the phone cannot reach the laptop's LAN
address. Use a tunnel (works from any network, HTTPS):
```bash
cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate --protocol http2   # prints https://<random>.trycloudflare.com; http2 because campus Wi-Fi drops QUIC
make ios-sync API_URL=https://<random>.trycloudflare.com          # bake it into the app, then build + install
```
The quick-tunnel address changes every time cloudflared restarts; keep it running for the whole
demo, or rebuild after a restart. Alternative without internet dependence: iPhone Personal
Hotspot over the cable (the Mac gets an "iPhone USB" interface; use that IP as API_URL).

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
`xcodebuild -workspace web/ios/App/App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' build`
then run from Xcode. The simulator has no camera or compass; GPS can be simulated from Xcode's
Debug → Location menu; the in-app "Simulate walk" also works.

## Android
`npx cap add android` in `web/` produces the matching Android project (needs Android Studio);
nothing in the web app changes.

## Listen conversation model (NVIDIA)

Export the key before starting the API; the app only needs `GET /voice/config` to say it is on:

```bash
NVIDIA_API_KEY=<key> make api-lan
```

Speech stays on the phone; the server calls NVIDIA NIM with the recognised text (`config/voice.yaml`).
