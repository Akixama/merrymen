import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { accountFromMnemonic, newMnemonic, validateMnemonic } from "@/crypto/mnemonic";
import { keystoreAvailable, writeOwner } from "@/crypto/keystore";
import { C } from "@/ui/tokens";

/**
 * Step one: bring a key into existence, or bring an existing one back.
 *
 * Creating does NOT save anything yet — the phrase is handed to the backup screen
 * and only written to the keychain once the owner has proved they copied it down.
 * Saving first would let someone reach a funded account with no backup, which is
 * the state that turns a lost phone into permanently unreachable money.
 *
 * Importing is different and does save immediately: the owner already has the
 * phrase written down somewhere, by definition, so re-quizzing them on it would be
 * theatre.
 */
export default function OnboardingStart() {
  const [mode, setMode] = useState<"choose" | "import">("choose");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (!(await keystoreAvailable())) {
        setError("This device has no secure keystore, so a key can't be stored safely here.");
        return;
      }
      const mnemonic = newMnemonic();
      // Passed through navigation, not persisted. The backup screen owns the
      // decision to commit it.
      router.push({ pathname: "/onboarding/backup", params: { mnemonic } });
    } finally {
      setBusy(false);
    }
  }, []);

  const restore = useCallback(async () => {
    setError(null);
    const check = validateMnemonic(phrase);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy(true);
    try {
      if (!(await keystoreAvailable())) {
        setError("This device has no secure keystore, so a key can't be stored safely here.");
        return;
      }
      await writeOwner(check.mnemonic);
      router.replace("/onboarding/grant");
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
      <Text style={styles.h1}>Your key, your machine</Text>
      <Text style={styles.lede}>
        merrymen creates a key that lives only on this phone. It signs the permission wall your agent trades
        inside — and it is the only thing that can ever move your funds back out.
      </Text>

      {mode === "choose" ? (
        <>
          <Pressable style={styles.primary} disabled={busy} onPress={create}>
            {busy ? <ActivityIndicator color="#08120e" /> : <Text style={styles.primaryText}>Create a new key</Text>}
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setMode("import")}>
            <Text style={styles.secondaryText}>I already have a recovery phrase</Text>
          </Pressable>

          <View style={styles.note}>
            <Text style={styles.noteText}>
              Next you&apos;ll be shown twelve words and asked to prove you wrote them down. That step can&apos;t
              be skipped, because those words are the only way back if this phone is lost or wiped.
            </Text>
          </View>
        </>
      ) : (
        <>
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
            // Keeps the phrase out of the keyboard's learned-words dictionary.
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
            {busy ? <ActivityIndicator color="#08120e" /> : <Text style={styles.primaryText}>Restore</Text>}
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setMode("choose")}>
            <Text style={styles.secondaryText}>Back</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 72, paddingBottom: 60, gap: 14 },
  h1: { color: C.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  lede: { color: C.dim, fontSize: 15, lineHeight: 22, marginBottom: 10 },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  primaryText: { color: "#08120e", fontSize: 16, fontWeight: "700" },
  secondary: {
    backgroundColor: C.bg2,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  secondaryText: { color: C.text2, fontSize: 15 },
  note: { backgroundColor: C.bg2, borderRadius: 10, padding: 14, marginTop: 12 },
  noteText: { color: C.dim, fontSize: 13, lineHeight: 20 },
  label: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginTop: 6 },
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
});
