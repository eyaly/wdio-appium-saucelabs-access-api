# wdio-appium-saucelabs-access-api

Uses the Sauce Labs
[Real Device Access API](https://docs.saucelabs.com/mobile-apps/rdc-access-api/real-device-access-api-introduction)
to reserve a **real iOS device**, enable network capture, install the
[PawKnits iOS app](https://github.com/eyaly/PawKnits-iOS) and record a Sauce Labs test.

## Flow ([run.js](run.js))

| Step | API call |
| --- | --- |
| Start session | `POST /rdc/v2/sessions`, then poll until `ACTIVE` |
| Enable network capture | `POST /sessions/{id}/device/enableNetworkCapture` |
| Start recording | `POST /sessions/{id}/startTest` |
| Install the app (instrumentation enabled) | `POST /sessions/{id}/device/installApp`, poll `listAppInstallations` until `FINISHED` |
| — | wait `RECORD_SECONDS` (use the app in Live View) |
| End recording | `POST /sessions/{id}/endTest` |
| End session | `disableNetworkCapture`, `DELETE /sessions/{id}`, poll until `CLOSED` |

The device is released on errors and Ctrl+C too. Capture is enabled before the install because it
only records connections opened after it starts. Recording starts before the install, so the
installation is in the video. The HAR is in the test's **Network** tab.

## Setup

Requirements: Node.js 22+, a Sauce Labs **Enterprise** account (the Access API is Enterprise-only),
and `PawKnits.ipa` in [App Storage](https://docs.saucelabs.com/mobile-apps/app-storage/).

```bash
cp .env.example .env   # optional: settings can also be system env vars
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` | — | Credentials |
| `SAUCE_REGION` | `eu-central-1` | `eu-central-1`, `us-west-1` or `us-east-4` |
| `IOS_APP` | `storage:filename=PawKnits.ipa` | App in App Storage |
| `IOS_DEVICE` | any iOS device | Exact device name or regex, e.g. `iPhone_16_real` or `iPhone.*` |
| `RECORD_SECONDS` | `60` | How long to keep recording after the app is installed |
| `SAUCE_TEST_NAME`, `SAUCE_BUILD_NAME` | generated | Name/build of the recorded test |
| `ACCESS_API_SESSION_DURATION` | `PT30M` | Safety net: the device is released after this even if the run dies |

## Docs

- [Test results (startTest / endTest)](https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/)
- [Network capture on real devices](https://docs.saucelabs.com/mobile-apps/features/network-capture)
- [Access API OpenAPI spec](https://github.com/saucelabs/real-device-api/blob/main/open_api_specification.yaml)
