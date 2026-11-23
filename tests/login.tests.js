/**
 * PawKnits login tests. run.js runs them one after another on the same Appium session,
 * in the order of this list. Each test gets the WebdriverIO `driver` and throws to fail.
 *
 * Demo accounts (PawKnits/Data/Auth.swift): doglover / woof1234 is valid,
 * locked / woof1234 is locked out, anything else does not match.
 */
const PASSWORD = 'woof1234';

const byId = (driver, id) => driver.$(`~${id}`); // accessibility id

/**
 * Hides the iOS keyboard the way PawKnits supports it: the login screen uses
 * `.scrollDismissesKeyboard(.interactively)`, so dragging the screen down dismisses it.
 * (`mobile: hideKeyboard` can't: the keyboard keys are "next" and "done", and "done" submits the form.)
 */
async function hideKeyboard(driver) {
    if (!(await driver.isKeyboardShown())) return;
    const { width, height } = await driver.getWindowSize();
    const x = Math.round(width / 2);
    await driver
        .action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x, y: Math.round(height * 0.2) }) // above the fields, on the scroll view
        .down()
        .move({ x, y: Math.round(height * 0.9), duration: 400 })
        .up()
        .perform();
    await driver.waitUntil(async () => !(await driver.isKeyboardShown()), {
        timeout: 5_000,
        timeoutMsg: 'the keyboard is still shown after dragging the screen down',
    });
}

/** Taps a field, types `text` into it and hides the keyboard. */
async function fill(driver, id, text) {
    await byId(driver, id).click();
    // Find it again: some fields are replaced by a new element when tapped
    // (e.g. iOS password TextField -> SecureTextField).
    const field = byId(driver, id);
    await field.clearValue();
    await field.addValue(text);
    //await hideKeyboard(driver);
}

/** Types the username and password into the login form and taps the Log in button. */
async function login(driver, username, password) {
    await fill(driver, 'login_username', username);
    await fill(driver, 'login_password', password);
    await byId(driver, 'login_button').click();
}

/** Waits until the login error shows `message` (the label stays on screen between tests). */
async function expectError(driver, message) {
    const error = byId(driver, 'login_error');
    await driver.waitUntil(async () => (await error.isDisplayed()) && (await error.getText()) === message, {
        timeout: 20_000,
        timeoutMsg: `login_error never showed "${message}"`,
    });
}

export const tests = [
    {
        name: 'wrong password shows an error',
        async run(driver) {
            await byId(driver, 'login_screen').waitForDisplayed({ timeout: 30_000 });
            await login(driver, 'doglover', 'wrong-password');
            await expectError(driver, 'Username and password do not match any user');
        },
    },
    {
        name: 'locked-out user shows an error',
        async run(driver) {
            await login(driver, 'locked', PASSWORD);
            await expectError(driver, 'Sorry, this account has been locked out.');
        },
    },
    {
        name: 'valid user opens the shop',
        async run(driver) {
            await login(driver, 'doglover', PASSWORD);
            await byId(driver, 'shop_screen').waitForDisplayed({ timeout: 20_000 });
        },
    },
];
