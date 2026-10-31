import test from "node:test";
import assert from "node:assert/strict";
import { applicationArgs } from "./lifecycle";

test("packaged launch forwards Android paths through LaunchServices before application arguments", () => {
  const args = applicationArgs("/Applications/Device Deck.app", "/Users/me/Deck profile", {
    ANDROID_HOME: "/Users/me/Android SDK",
    ANDROID_SDK_ROOT: "/Users/me/Android SDK",
    ANDROID_USER_HOME: "/Users/me/Android settings",
    ANDROID_AVD_HOME: "/Users/me/AVD pool",
    DEVICE_DECK_PORT: "47832",
    UNRELATED_SECRET: "never-forward",
  });
  const appArguments = args.indexOf("--args");
  assert.deepEqual(args.slice(4, appArguments), [
    "--env", "ANDROID_HOME=/Users/me/Android SDK",
    "--env", "ANDROID_SDK_ROOT=/Users/me/Android SDK",
    "--env", "ANDROID_USER_HOME=/Users/me/Android settings",
    "--env", "ANDROID_AVD_HOME=/Users/me/AVD pool",
  ]);
  assert.deepEqual(args.slice(appArguments + 1), ["--service", "--profile", "/Users/me/Deck profile", "--port", "47832"]);
  assert.ok(!args.some(value => value.includes("never-forward")));
});

test("packaged launch omits absent or empty Android paths", () => {
  assert.deepEqual(applicationArgs("/Applications/Device Deck.app", "/profile", { ANDROID_HOME: "" }), [
    "-n", "-g", "-a", "/Applications/Device Deck.app", "--args", "--service", "--profile", "/profile",
  ]);
});
