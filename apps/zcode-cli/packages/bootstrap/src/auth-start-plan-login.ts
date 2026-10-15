import { dirname, join } from "node:path";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { LoginZCodeCliOptions } from "./auth-login-contract.js";
import {
  readStandaloneCodingPlanProviders,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
} from "./app/standalone-account-provider-runtime.js";

/** 授权成功后先断开旧 OAuth 项目身份；手工配置不参与账户套餐登录。 */
export async function prepareStandaloneStartPlanLogin(
  store: SharedZCodeCredentialStore,
  options: LoginZCodeCliOptions,
  env: Record<string, string | undefined>,
  family: "zai" | "bigmodel",
): Promise<string> {
  for (const provider of await readStandaloneCodingPlanProviders(env)) {
    if (provider.family !== family) continue;
    const source = await store.load(standaloneAccountAuthSourceCredentialKey(provider.providerId));
    const identity = standaloneAccountIdentityCredentialKey(provider.providerId);
    if (source !== "manual" && (await store.load(identity))) await store.delete(identity);
  }
  return (
    options.personalProviderConfigPath ??
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ??
    join(dirname(store.filePath), "provider_config.json")
  );
}
