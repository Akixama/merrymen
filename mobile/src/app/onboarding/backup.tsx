import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { buildQuiz } from "@/crypto/mnemonic";
import { writeOwner } from "@/crypto/keystore";
import { C } from "@/ui/tokens";

/**
 * The backup step, and it is deliberately not skippable.
 *
 * Per worker/src/recover.ts the owner key is the ONLY thing that can sweep a smart
 * account — the session key cannot, and after a kill switch it is gone entirely.
 * So a key with no backup is funds with a single point of failure that the owner
 * cannot see. On a phone-only product that point of failure is "drops phone in a
 * canal".
 *
 * The quiz is the difference between showing someone a phrase and knowing they
 * copied it. It is three words at random positions, chosen after they tap
 * continue, so screenshotting the quiz itself doesn't help.
 *
 * NOTHING IS PERSISTED UNTIL THE QUIZ PASSES. That ordering is the whole point: a
 * key saved before the backup is confirmed can strand funds, a key discarded
 * because the owner bailed halfway costs nothing.
 */
export default function Backup() {
  const { mnemonic } = useLocalSearchParams<{ mnemonic: string }>();
  const words = useMemo(() => (mnemonic ?? "").split(" ").filter(Boolean), [mnemonic]);

  const [stage, setStage] = useState<"show" | "quiz">("show");
  const [quiz, setQuiz] = useState<ReturnType<typeof buildQuiz>>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (words.length === 0) {
    return (
      <View style={styles.root}>
        <Text style={styles.error}>No phrase was passed to this screen. Start again.</Text>
      </View>
    );
  }

  const startQuiz = () => {
    setQuiz(buildQuiz(mnemonic!, 3));
    setAnswers({});
    setError(null);
    setStage("quiz");
  };

  const submit = async () => {
    const wrong = quiz.filter((q) => answers[q.index] !== q.answer);
    if (wrong.length > 0) {
      // Re-roll the questions. Otherwise a wrong answer becomes a two-guess
      // multiple choice, which proves nothing.
      setError(`${wrong.length === 1 ? "One word is" : `${wrong.length} words are`} wrong. Check your copy — here are three fresh questions.`);
      setQuiz(buildQuiz(mnemonic!, 3));
      setAnswers({});
      return;
    }
    setBusy(true);
    try {
      await writeOwner(mnemonic!);
      router.replace("/onboarding/grant");
    } catch {
      setError("Couldn't save to the keychain. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {stage === "show" ? (
        <>
          <Text style={styles.h1}>Write these down</Text>
          <Text style={styles.lede}>
            Twelve words, in this order. They are the only way to reach your funds if this phone is lost, wiped,
            or stops working. Nobody can send them to you again — not us, not anyone.
          </Text>

          <View style={styles.grid}>
            {words.map((w, i) => (
              <View key={`${i}-${w}`} style={styles.wordCell}>
                <Text style={styles.wordIndex}>{i + 1}</Text>
                <Text style={styles.word}>{w}</Text>
              </View>
            ))}
          </View>

          <View style={styles.warn}>
            <Text style={styles.warnText}>
              Paper beats screenshots. A photo in your camera roll syncs to the cloud, and anyone who reaches
              that reaches your money.
            </Text>
          </View>

          <Pressable
            style={styles.secondary}
            onPress={async () => {
              await Clipboard.setStringAsync(mnemonic!);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            }}
          >
            <Text style={styles.secondaryText}>{copied ? "copied — clear your clipboard after" : "copy to clipboard"}</Text>
          </Pressable>

          <Pressable style={styles.primary} onPress={startQuiz}>
            <Text style={styles.primaryText}>I&apos;ve written them down</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.h1}>Prove it</Text>
          <Text style={styles.lede}>
            Three words from the phrase you just saved. This is the only way to know the backup is real before
            money depends on it.
          </Text>

          {quiz.map((q) => (
            <View key={q.index} style={styles.question}>
              <Text style={styles.qLabel}>Word #{q.index + 1}</Text>
              <View style={styles.options}>
                {q.options.map((opt) => {
                  const selected = answers[q.index] === opt;
                  return (
                    <Pressable
                      key={opt}
                      style={[styles.option, selected && styles.optionOn]}
                      onPress={() => setAnswers((a) => ({ ...a, [q.index]: opt }))}
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextOn]}>{opt}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.primary, Object.keys(answers).length < quiz.length && styles.primaryOff]}
            disabled={busy || Object.keys(answers).length < quiz.length}
            onPress={submit}
          >
            {busy ? <ActivityIndicator color="#08120e" /> : <Text style={styles.primaryText}>Confirm and continue</Text>}
          </Pressable>

          <Pressable style={styles.ghost} onPress={() => setStage("show")}>
            <Text style={styles.ghostText}>show the words again</Text>
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
  lede: { color: C.dim, fontSize: 15, lineHeight: 22 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  wordCell: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 7,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: "30%",
  },
  wordIndex: { color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  word: { color: C.text, fontSize: 15, fontWeight: "600" },
  warn: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    marginTop: 6,
  },
  warnText: { color: C.gold, fontSize: 13, lineHeight: 19 },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  primaryOff: { opacity: 0.4 },
  primaryText: { color: "#08120e", fontSize: 16, fontWeight: "700" },
  secondary: {
    backgroundColor: C.bg2,
    borderRadius: 12,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  secondaryText: { color: C.text2, fontSize: 14 },
  ghost: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  ghostText: { color: C.faint, fontSize: 13 },
  question: { gap: 8, marginTop: 8 },
  qLabel: { color: C.dim, fontSize: 13, fontWeight: "600" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: "center",
  },
  optionOn: { borderColor: C.green, backgroundColor: "rgba(52,211,153,0.12)" },
  optionText: { color: C.text2, fontSize: 14 },
  optionTextOn: { color: C.green, fontWeight: "600" },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
});
