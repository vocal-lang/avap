# Google Play Upload Package (VOCAL)

This project now has signed Android release artifacts ready for upload.

## Files to upload

- Preferred for Play Console: `android/app/build/outputs/bundle/release/app-release.aab`
- Optional (side-load testing only): `android/app/build/outputs/apk/release/app-release.apk`

## App identity (from Android config)

- Application ID / Package name: `org.vocalonline`
- App name: `AVAP`
- Current versionCode: `1`
- Current versionName: `1.0`

## Signing setup completed

- Upload keystore created at: `android/release.keystore`
- Gradle signing properties created at: `android/keystore.properties`
- Keystore alias: `upload`

Important:
- Keep `release.keystore` and `keystore.properties` backed up securely.
- Never commit these credentials to source control.

## Play Console internal testing upload steps

1. Open [Google Play Console](https://play.google.com/console/) and create app `AVAP` (if not already created).
2. Choose default language and app category.
3. Complete mandatory policy pages:
   - App access
   - Ads declaration
   - Data safety
   - Content rating
   - Target audience
4. Go to `Release` -> `Testing` -> `Internal testing`.
5. Create a new release and upload:
   - `app-release.aab`
6. Add release notes (example):
   - `Initial internal test release of VOCAL Android shell`
7. Add tester emails/group and roll out release.

## Required listing assets checklist

- App icon (512x512 PNG)
- Feature graphic (1024x500 PNG)
- Phone screenshots (at least 2)
- Short description (<= 80 chars)
- Full description
- Privacy policy URL

## Recommended description draft

Short description:
`AVAP connects users to VOCAL resources, calendar, and services.`

Full description:
`AVAP is the mobile shell for the VOCAL platform. The app provides quick access to key resources including home, about, calendar, map, and hotline pages. This release is intended for internal testing before wider rollout.`

## Test checklist after upload

- Install from internal testing link on a physical Android device.
- Open app and confirm it loads `https://vocal-49d97.web.app`.
- Verify navigation to Home, About, Calendar, Map, and Hotline.
- Verify login/admin pages load as expected where applicable.
- Confirm no blank screen on cold launch with network available.

## Future release note

For every subsequent Play upload:
- Increase `versionCode` in `android/app/build.gradle`
- Optionally update `versionName`
- Rebuild signed AAB before uploading
