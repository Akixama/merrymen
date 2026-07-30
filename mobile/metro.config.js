const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const base = config.resolver.resolveRequest;

/**
 * Stub merkletreejs.
 *
 * @zerodev/permissions' barrel re-exports serializeMultiChainPermissionAccounts,
 * which pulls in merkletreejs -> require('buffer') and crypto-js -> require('crypto').
 * Neither exists in React Native, so importing ANY symbol from that barrel drags
 * two unresolvable Node built-ins into the bundle — even though we never call the
 * multi-chain path.
 *
 * merrymen signs SINGLE-CHAIN grants only, so the cheaper fix is to stub the
 * module rather than ship buffer + crypto shims for code that never runs.
 *
 * CONSEQUENCE, stated plainly: serializeMultiChainPermissionAccounts will throw at
 * runtime. If merrymen ever adds multi-chain grants, DELETE this stub and add real
 * buffer/crypto polyfills instead of quietly re-enabling a broken path.
 */
config.resolver.resolveRequest = (ctx, moduleName, platform) => {
  if (moduleName === "merkletreejs") return { type: "empty" };
  return (base ?? ctx.resolveRequest)(ctx, moduleName, platform);
};

module.exports = config;
