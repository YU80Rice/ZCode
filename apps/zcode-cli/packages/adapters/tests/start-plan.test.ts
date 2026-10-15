import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HttpClientPort } from "@zcode/contracts";
import { createStartPlanBalanceClient } from "../src/auth/start-plan.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(status = 200) {
  const directory = await mkdtemp(join(tmpdir(), "start-plan-client-"));
  directories.push(directory);
  const request = vi.fn<HttpClientPort["request"]>(async () => ({
    status,
    statusText: "Fixture",
    url: "https://example.test",
    headers: { date: "Thu, 01 Jan 1970 00:16:40 GMT" },
    bytes: 0,
    durationMs: 0,
    body: new TextEncoder().encode(
      JSON.stringify({
        code: 0,
        data: {
          server_time: 900,
          plans: [{ user_plan_id: "instance", status: "active", ends_at: 2000 }],
          balances: [
            { user_plan_id: "instance", available_units: 30, capabilities: ["model:GLM-5.3"] },
          ],
        },
      }),
    ),
  }));
  return {
    request,
    client: createStartPlanBalanceClient({
      httpClient: { request },
      env: { ZCODE_DATA_BASE_DIR: directory },
    }),
  };
}
it("向官方余额端点发送 Bearer JWT、持久设备标识与 CLI 来源", async () => {
  const f = await fixture();
  const trace = { traceId: "start-plan-trace" } as never;
  expect(await f.client.read("fixture-jwt", undefined, trace)).toMatchObject({
    status: "available",
    models: ["GLM-5.3"],
  });
  const first = f.request.mock.calls[0][0];
  expect(first.trace).toBe(trace);
  expect(first.url).toContain("/api/v1/zcode-plan/billing/balance?app_version=");
  expect(first.headers).toMatchObject({
    Authorization: "Bearer fixture-jwt",
    "X-Title": "Z Code@cli",
  });
  expect(first.headers?.["X-Device-Mid"]).toMatch(/^[a-f0-9-]{36}$/);
  await f.client.read("fixture-jwt");
  expect(f.request.mock.calls[1][0].headers?.["X-Device-Mid"]).toBe(
    first.headers?.["X-Device-Mid"],
  );
});
it.each([
  [401, "not-authenticated"],
  [403, "verification-required"],
  [429, "error"],
])("HTTP %s 不会借用其他账户额度", async (code, status) => {
  const f = await fixture(Number(code));
  expect(await f.client.read("fixture-jwt")).toMatchObject({ status, models: [] });
  expect(f.request).toHaveBeenCalledTimes(1);
});
