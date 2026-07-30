import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { accountFromMnemonic, validateMnemonic } from "@/crypto/mnemonic";
import { forgetOwner, writeOwner } from "@/crypto/keystore";
import { C } from "@/ui/tokens";

/**
 * "Your key is gone" — the screen that exists so the app never silently replaces
 * a key that controls money.
 *
 * Reached when the keystore's marker is present but the secret reads back null.
 * On Android that specifically means the OS destroyed the key because biometric
 * enrolment changed — the module catches KeyPermanentlyInvalidatedException and
 * returns null, which is indistinguishable from "nothing stored" unless something
 * else remembers. Without this screen the app would conclude "first run", generate
 * a fresh key, and quietly strand a funded smart account forever.
 *
 * There is exactly one way out and it is the recovery phrase, because per
 * worker/src/recover.ts the owner key is the only signer that can sweep the
 * account. Saying that plainly is kinder than implying support can help.
 */
export default function Recover() {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = useCallback(async () => {
    const check = validateMnemonic(phrase);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy(true);
    try {
      await writeOwner(check.mnemonic);
      router.replace("/");
    } catch {
      setError("Couldn't save to the keychain. Try again.");
    } finally {
      setBusy(false);
    }
  }, [phrase]);

  const preview = (() => {
    const check = validateMnemonic(phrase);
    if (!check.ok) return null;
    try {
      return accountFromMnemonic(check.mnemonic).address;
    } catch {
      return null;
    }
  })();

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>This device lost its key</Text>
      <Text style={styles.lede}>
        The key was stored here, and the phone&apos;s keystore no longer has it. That normally happens when the
        device&apos;s fingerprint or face setup changed, which wipes anything locked to it.
      </Text>
      <Text style={styles.lede}>
        <Text style={styles.strong}>Your funds are fine.</Text> They live in the smart account on-chain, not on
        this phone. Enter your recovery phrase to take control of it again.
      </Text>

      <Text style={styles.label}>Recovery phrase</Text>
      <TextInput
        style={styles.input}
        value={phrase}
        onChangeText={(t) => {
          setPhrase(t);
          setError(null);
        }}
        placeholder="twelve words, separated by spaces"
        placeholderTextColor={C.faint}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        textContentType="none"
      />
      {preview && (
        <Text style={styles.preview}>
          owner address <Text style={styles.previewAddr}>{preview}</Text>
        </Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.primary} disabled={busy} onPress={restore}>
        {busy ? <ActivityIndicator color="#08120e" /> : <Text style={styles.primaryText}>Restore my key</Text>}
      </Pressable>

      <View style={styles.divider} />

      <Text style={styles.smallHead}>If you don&apos;t have the phrase</Text>
      <Text style={styles.small}>
        Then this account cannot be recovered — not by us, not by anyone. The owner key is the only signer that
        can move funds out, and it existed only on this device and on your written copy. We would rather say
        that plainly than let you keep trying.
      </Text>

      {/* Starting over is a real choice, but it must be an explicit one that names
          what it costs — not a convenient escape from an error screen. */}
      <Pressable
        style={styles.danger}
        onPress={async () => {
          await forgetOwner();
          router.replace("/onboarding");
        }}
      >
        <Text style={styles.dangerText}>Forget this account and start fresh</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 72, paddingBottom: 60, gap: 12 },
  h1: { color: C.text, fontSize: 27, fontWeight: "700", letterSpacing: -0.5 },
  lede: { color: C.dim, fontSize: 15, lineHeight: 22 },
  strong: { color: C.green, fontWeight: "700" },
  label: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginTop: 10 },
  input: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    color: C.text,
    padding: 14,
    minHeight: 110,
    fontSize: 15,
    textAlignVertical: "top",
  },
  preview: { color: C.dim, fontSize: 12 },
  previewAddr: { color: C.text2 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  primaryText: { color: "#08120e", fontSize: 16, fontWeight: "700" },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 18 },
  smallHead: { color: C.text2, fontSize: 14, fontWeight: "600" },
  small: { color: C.faint, fontSize: 13, lineHeight: 20 },
  danger: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(251,113,133,0.35)",
  },
  dangerText: { color: C.red, fontSize: 14 },
});
