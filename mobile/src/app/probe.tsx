import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { warmCurve } from "@/crypto/warmup";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { C, GUTTER } from "@/ui/tokens";

/**
 * THE CRYPTO PROBE. Not a feature — a proof, and it earns its place in the repo.
 *
 * It exists to settle two risks that no amount of UI work would reveal, and it has
 * to be a real reachable route because Metro only bundles what the entry graph
 * reaches. A "throwaway file" that nothing imports proves nothing.
 *
 *   RISK 1 — does the bundle even resolve? Importing these five @zerodev/viem
 *   entry points is what drags the whole crypto graph in, including the
 *   merkletreejs path that metro.config.js stubs. `npx expo export` over this
 *   route runs the real Metro resolver; if it exports clean, the shim set is
 *   complete. No device needed.
 *
 *   RISK 3 — is Hermes fast enough, and is the polyfilled crypto CORRECT? Every
 *   published timing for this stack was measured on desktop V8, not on a phone
 *   with no JIT. So each step is timed here. And the address check below is the
 *   part that actually matters: a derived smart-account address that matches what
 *   the same owner key produces on the web app proves the polyfilled crypto is
 *   byte-identical. Fast but wrong would be far worse than slow.
 *
 * Read timings from a RELEASE build only (`npx expo run:android --variant release`).
 * Dev-mode numbers are meaningless here and will send you chasing ghosts.
 */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;

type Step = { name: string; ms: number; note?: string };

export default function Probe() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();
  const [steps, setSteps] = useState<Step[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (warm: boolean) => {
    setBusy(true);
    setSteps([]);
    setAccount(null);
    setError(null);
    const out: Step[] = [];
    const time = async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      const t0 = performance.now();
      const v = await fn();
      out.push({ name, ms: Math.round((performance.now() - t0) * 100) / 100 });
      setSteps([...out]);
      return v;
    };

    try {
      if (warm) {
        warmCurve();
        // Give the queued warm-up a turn before measuring.
        await new Promise((r) => setTimeout(r, 1200));
      }

      const publicClient = createPublicClient({ transport: http(RPC) });

      const ownerPrivateKey = await time("generatePrivateKey", () => generatePrivateKey());
      const ownerAccount = await time("privateKeyToAccount (owner)", () => privateKeyToAccount(ownerPrivateKey));
      setOwner(ownerAccount.address);

      const entryPoint = getEntryPoint("0.7");

      const ecdsaValidator = await time("signerToEcdsaValidator", () =>
        signerToEcdsaValidator(publicClient, {
          signer: ownerAccount,
          entryPoint,
          kernelVersion: KERNEL_V3_3,
        }),
      );

      const sessionPrivateKey = await time("generatePrivateKey (session)", () => generatePrivateKey());
      const sessionAccount = privateKeyToAccount(sessionPrivateKey);
      const sessionSigner = await time("toECDSASigner", () => toECDSASigner({ signer: sessionAccount }));

      const now = Math.floor(Date.now() / 1000);
      const permissionValidator = await time("toPermissionValidator", () =>
        toPermissionValidator(publicClient, {
          entryPoint,
          kernelVersion: KERNEL_V3_3,
          signer: sessionSigner,
          // A minimal but REAL policy set. toCallPolicy is deliberately omitted here
          // so the probe stays independent of the token registry — the point is to
          // exercise the crypto and serialization path, not to mint a usable grant.
          policies: [
            toTimestampPolicy({ validAfter: now, validUntil: now + 3600 }),
            toRateLimitPolicy({ count: 10, interval: 86_400 }),
          ],
        }),
      );

      const kernel = await time("createKernelAccount", () =>
        createKernelAccount(publicClient, {
          entryPoint,
          kernelVersion: KERNEL_V3_3,
          plugins: { sudo: ecdsaValidator, regular: permissionValidator },
        }),
      );
      setAccount(kernel.address);

      const serialized = await time("serializePermissionAccount", () =>
        serializePermissionAccount(kernel, sessionPrivateKey),
      );
      out.push({ name: "serialized length", ms: 0, note: `${serialized.length} chars` });
      setSteps([...out]);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const total = steps.reduce((s, x) => s + x.ms, 0);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}>
      <Text style={styles.h1}>Crypto probe</Text>
      <Text style={styles.sub}>
        Proves the ZeroDev + viem graph resolves and runs under Hermes. Chain {CHAIN_ID}. Read timings from a
        release build only — dev mode numbers mean nothing.
      </Text>

      {/* Both buttons dim while a run is in flight, and both say so. Only the
          first used to change its label, so during a warm run — which opens with
          a deliberate 1200ms wait before the first step is even recorded — the
          screen was indistinguishable from idle and both buttons still looked
          tappable. */}
      <View style={styles.row}>
        <Pressable style={[styles.btn, busy && styles.btnBusy]} disabled={busy} onPress={() => run(false)}>
          <Text style={styles.btnText}>{busy ? "running…" : "run cold"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlt, busy && styles.btnBusy]}
          disabled={busy}
          onPress={() => run(true)}>
          <Text style={[styles.btnText, styles.btnAltText]}>{busy ? "running…" : "run warmed"}</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.err}>{error}</Text>}

      {steps.map((s) => (
        <View key={s.name} style={styles.step}>
          <Text style={styles.stepName}>{s.name}</Text>
          <Text style={styles.stepMs}>{s.note ?? `${s.ms} ms`}</Text>
        </View>
      ))}

      {steps.length > 0 && !error && (
        <View style={styles.step}>
          <Text style={[styles.stepName, styles.totalLabel]}>total</Text>
          <Text style={[styles.stepMs, styles.totalLabel]}>{Math.round(total)} ms</Text>
        </View>
      )}

      {owner && <Addr label="owner EOA" value={owner} />}
      {account && (
        <Addr label="derived smart account" value={account}>
          <Text style={styles.addrNote}>
            The correctness check: feed the same owner key to the web app and this address must match
            exactly. If it does, the polyfilled crypto is byte-identical. A fresh key is generated each
            run, so to compare you must pin one.
          </Text>
        </Addr>
      )}
    </ScrollView>
  );
}

/**
 * An address, in a face where you can actually compare one to another.
 *
 * The whole point of this screen is checking that 42 hex characters produced on
 * a phone match 42 produced in a browser, and a proportional font is the worst
 * possible setting for that: 0/O and 1/l land at different widths, so the eye
 * has nothing to track against. Monospaced, and tappable to copy — comparing by
 * reading it aloud is not a workflow.
 */
function Addr({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      style={styles.addrBox}
      onPress={() => {
        void Clipboard.setStringAsync(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}>
      <View style={styles.addrHead}>
        <Text style={styles.addrLabel}>{label}</Text>
        <Text style={styles.addrCopy}>{copied ? "copied" : "tap to copy"}</Text>
      </View>
      <Text style={styles.addr}>{value}</Text>
      {children}
    </Pressable>
  );
}

// Colours come from the token layer. This file used to re-declare the entire
// palette as hex literals — every one an exact duplicate of a token — plus a
// second type scale, which is why it read like a page from a different product.
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: GUTTER, gap: 12 },
  h1: { color: C.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.8 },
  sub: { color: C.dim, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  btn: {
    backgroundColor: C.green,
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 10,
    minHeight: 46,
    justifyContent: "center",
  },
  btnAlt: { backgroundColor: C.bg3 },
  btnBusy: { opacity: 0.45 },
  btnText: { color: "#08120e", fontWeight: "700", fontSize: 14 },
  // The secondary button needs its OWN text colour. It shared the primary's
  // near-black label while carrying a near-black background — rgb(8,18,14) on
  // rgb(29,43,37) is 1.29:1, so the words were invisible and the control read as
  // an empty slab.
  btnAltText: { color: C.text },
  err: { color: C.red, fontSize: 13, marginTop: 8 },
  step: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomColor: C.border,
    borderBottomWidth: 1,
    paddingVertical: 9,
    gap: 12,
  },
  stepName: { color: C.text2, fontSize: 13, flexShrink: 1 },
  stepMs: { color: C.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  totalLabel: { fontWeight: "700", color: C.green },
  addrBox: { backgroundColor: C.bg2, borderRadius: 12, padding: 14, gap: 6, marginTop: 8 },
  addrHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  addrLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  addrCopy: { color: C.dim, fontSize: 11 },
  addr: {
    color: C.text,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  addrNote: { color: C.dim, fontSize: 12, lineHeight: 18, marginTop: 4 },
});
