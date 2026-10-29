import test from "node:test";
import assert from "node:assert/strict";
import { probeDatabase } from "./check-setup.mjs";

test("setup probe sends only HEAD, reads no customer data, and never returns secrets", async () => {
  const key = "fixture-secret";
  const report = await probeDatabase({ url: "https://fixture.supabase.co", key, projectRef: "fixture", tables: ["grupos"] },
    async (url, options) => {
      assert.equal(options.method, "HEAD");
      assert.equal(url.searchParams.get("limit"), "0");
      assert.equal(options.body, undefined);
      return { ok: true, status: 200, json: () => { throw Error("Must not read rows"); } };
    });
  assert.equal(report.status, "ok");
  assert.ok(!JSON.stringify(report).includes(key));
});

test("setup probe refuses a different project before sending its credentials", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error("Unexpected request"); };
  assert.equal((await probeDatabase({ url: "https://other.example", key: "fixture", projectRef: "fixture", tables: ["grupos"] }, fetcher)).status, "unexpected_project");
  assert.equal((await probeDatabase({ url: "", key: "", projectRef: "fixture", tables: [] }, fetcher)).status, "missing_credentials");
  assert.equal(calls, 0);
});
