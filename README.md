# wdio-appium-saucelabs-access-api

Uses the Sauce Labs
[Real Device Access API](https://docs.saucelabs.com/mobile-apps/rdc-access-api/real-device-access-api-introduction)
to reserve a **real iOS device**, enable network capture, install the
[PawKnits iOS app](https://github.com/eyaly/PawKnits-iOS), record a Sauce Labs test and run
Appium login tests on the Appium server Sauce Labs hosts next to the device.

## Flow ([run.js](run.js))

| Step | API call |
| --- | --- |
| Start session | `POST /rdc/v2/sessions`, then poll until `ACTIVE` |
| Enable network capture | `POST /sessions/{id}/device/enableNetworkCapture` |
| Start recording | `POST /sessions/{id}/startTest` |
| Install the app (instrumentation enabled) | `POST /sessions/{id}/device/installApp`, poll `listAppInstallations` until `FINISHED` |
| Start the hosted Appium server | `POST /sessions/{id}/appiumserver` → returns the Appium URL |
| Create an Appium session | WebdriverIO `remote()` on that URL, with your Sauce credentials |
| Run the tests | [tests/login.tests.js](tests/login.tests.js), one after another |
| Delete the Appium session | `driver.deleteSession()` |
| End recording | `POST /sessions/{id}/endTest` (`passed` only if every test passed) |
| End session | `disableNetworkCapture`, `DELETE /sessions/{id}`, poll until `CLOSED` |

The device is released on errors and Ctrl+C too. Capture is enabled before the install because it
only records connections opened after it starts. Recording starts before the install, so the
installation is in the video. A failing test doesn't stop the next one. The recorded test is listed under **Access API → Test Results** in the Sauce Labs menu (not
under Automated → Real Devices); the run prints its link. The HAR is in the test's **Network** tab.

## Setup

Requirements: Node.js 22+, a Sauce Labs **Enterprise** account (the Access API is Enterprise-only),
and `PawKnits.ipa` in [App Storage](https://docs.saucelabs.com/mobile-apps/app-storage/).

```bash
npm install
cp .env.example .env   # optional: settings can also be system env vars
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` | — | Credentials |
| `SAUCE_REGION` | `eu-central-1` | `eu-central-1`, `us-west-1` or `us-east-4` |
| `IOS_APP` | `storage:filename=PawKnits.ipa` | App in App Storage |
| `IOS_DEVICE` | any iOS device | Exact device name or regex, e.g. `iPhone_16_real` or `iPhone.*` |
| `IOS_BUNDLE_ID` | `com.pawknits.demo` | Bundle id the tests restart before running |
| `APPIUM_VERSION` | `latest` | Version of the hosted Appium server |
| `SAUCE_TEST_NAME`, `SAUCE_BUILD_NAME` | generated | Name/build of the recorded test |
| `ACCESS_API_SESSION_DURATION` | `PT30M` | Safety net: the device is released after this even if the run dies |

## Tests

[tests/login.tests.js](tests/login.tests.js) is a list of `{ name, run(driver) }`. `run.js` runs
them in that order on one Appium session; a test fails by throwing. To add a test, add an entry.

| Test | Checks |
| --- | --- |
| wrong password shows an error | `login_error` = "Username and password do not match any user" |
| locked-out user shows an error | `login_error` = "Sorry, this account has been locked out." |
| valid user opens the shop | `shop_screen` is displayed |

## Docs

- [Test results (startTest / endTest)](https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/)
- [Sauce-hosted Appium](https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/)
- [Network capture on real devices](https://docs.saucelabs.com/mobile-apps/features/network-capture)
- [Access API OpenAPI spec](https://github.com/saucelabs/real-device-api/blob/main/open_api_specification.yaml)
