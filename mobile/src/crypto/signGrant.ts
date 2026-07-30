import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  GRANT_V4,
  TRADEABLE_V2,
  buildWallPolicies,
  robinhoodChain,
  usableExtraTokens,
  type CustomToken,
  type GrantCaps,
  type StoredGrant,
} from "@merrymen/core";
import { accountFromMnemonic } from "./mnemonic";

/**
 * Sign a grant on the phone.
 *
 * THE ONE RULE: the owner key never leaves this device. It is derived from the
 * mnemonic in memory, used to build the sudo validator, and dropped. What comes
 * out is a serialized SESSION account — capped on-chain, self-expiring, revocable
 * — and that is the only thing safe to hand to a server.
 *
 * This deliberately does NOT mirror the dashboard's session.ts, which puts
 * `demoOwnerPrivateKey` on the grant object and POSTs the whole thing to
 * /api/grants. On a self-hosted install that is a localhost round trip to a 0600
 * file on the same machine, so it is not a leak. From a phone talking to a hosted
 * API it would upload the owner key to someone else's server, which would make the
 * product's central claim false. So the field is simply absent here.
 *
 * The policy set itself comes from packages/core so the phone and the dashboard
 * sign the IDENTICAL wall — see packages/core/src/wall.ts, pinned by
 * worker/src/wall.test.ts.
 */

export type SignProgress = (step: string) => void;

export interface SignedGrant {
  /** Safe to transmit: capped, expiring, and useless outside its policies. */
  grant: Omit<StoredGrant, "demoOwnerPrivateKey">;
  /** The session key, which the worker needs in order to act. Not the owner key. */
  sessionPrivateKey: `0x${string}`;
}

export async function signGrant(args: {
  mnemonic: string;
  caps: GrantCaps;
  extraTokens?: readonly CustomToken[];
  rpcUrl?: string;
  onProgress?: SignProgress;
}): Promise<SignedGrant> {
  const say = args.onProgress ?? (() => {});
  const chain = robinhoodChain;
  const publicClient = createPublicClient({
    chain,
    transport: http(args.rpcUrl ?? chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint("0.7");

  say("deriving your key");
  const ownerAccount = accountFromMnemonic(args.mnemonic);

  say("building the sudo validator");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  say("minting a session key");
  const sessionPrivateKey = generatePrivateKey();
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(sessionPrivateKey) });

  say("assembling the wall");
  const { policies, now, expiresAt } = buildWallPolicies({ caps: args.caps, extraTokens: args.extraTokens });

  say("attaching the permissions");
  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer: sessionSigner,
    policies,
  });

  say("deriving the smart account");
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator, regular: permissionValidator },
  });

  say("signing");
  const serialized = await serializePermissionAccount(account, sessionPrivateKey);

  return {
    grant: {
      smartAccount: account.address,
      // The owner's ADDRESS, which is public. Not the key.
      owner: ownerAccount.address,
      sessionKeyAddress: sessionSigner.account.address,
      serialized,
      caps: args.caps,
      grantedAt: now,
      expiresAt,
      chainId: chain.id,
      // Tells the worker what this signature actually carries, rather than
      // letting it infer capabilities from a constant that may have moved since.
      grantFeatures: ["transfer", TRADEABLE_V2, GRANT_V4],
      grantTokens: usableExtraTokens(args.extraTokens).map((t) => t.address.toLowerCase()),
      demoSessionPrivateKey: sessionPrivateKey,
    },
    sessionPrivateKey,
  };
}
