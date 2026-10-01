import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loginProfiles } from "./http-client.js";

test("production login falls back through the validated native profiles", () => {
  assert.deepEqual(loginProfiles(), ["firefox_149", "firefox_147", "firefox_135", "safari_18"]);
  assert.deepEqual(loginProfiles("chrome_142"), ["chrome_142"]);
});
