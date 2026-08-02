import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import * as Clipboard from "expo-clipboard";
import type { StoredGrant } from "@merrymen/core";
import { EXPLORER } from "@/net/chainlinks";
import { feedOrigin, isMock } from "@/net/api";
import { chatUrl, fetchTelegramStatus, type TelegramStatus } from "@/net/telegram";
import { forgetOwner, readOwner } from "@/crypto/keystore";
import { clearGrant, readGrant, secondsLeft } from "@/crypto/grantStore";
import { accountFromMnemonic } from "@/crypto/mnemonic";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { C } from "@/ui/tokens";

/**
 * Settings — and mostly, telling the truth about what this app can and cannot do.
 *
 * The hard part here is the stop button. On the dashboard the kill switch is wired
 * end to end, because the dashboard sits on the same machine as the worker. This
 * app does not. Deleting a grant from this phone's keychain removes OUR copy; it
 * does not reach an agent that is already running elsewhere with the session key,
 * and it certainly does not touch the chain.
 *
 * A "revoke" button that only clears local state while an agent keeps trading
 * would be the single most dangerous thing in the product — someone would press
 * it, believe they were safe, and walk away. So the destructive action is named
 * for what it actually does, and the section above it explains what genuinely
 * stops an agent: the expiry that is already signed into the key, or moving the
 * funds with the owner key.
 */

function short(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-8)}`;
}

function countdown(sec: number): string {
  if (sec <= 0) return "expired";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Settings() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();
  const [grant, setGrant] = useState<Omit<StoredGrant, "demoOwnerPrivateKey"> | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tg, setTg] = useState<TelegramStatus | null>(null);

  useEffect(() => {
    void fetchTelegramStatus(isMock ? null : feedOrigin).then((r) => {
      if (r.ok) setTg(r.status);
    });
  }, []);

  const openTelegram = useCallback(async () => {
    if (!tg?.botUsername) return;
    const url = chatUrl(tg.botUsername, tg.linkCode);
    // Telegram not installed is a normal state, not an error — the same URL works
    // in a browser, so fall through to it rather than failing silently.
    await Linking.openURL(url).catch(() => {});
  }, [tg]);

  useEffect(() => {
    void (async () => {
      setGrant(await readGrant());
      const status = await readOwner();
      if (status.state === "present") {
        try {
          setOwner(accountFromMnemonic(status.mnemonic).address);
        } catch {
          /* an unreadable key shows as absent rather than crashing the screen */
        }
      }
      setLoaded(true);
    })();
  }, []);

  /**
   * Reveal the phrase behind a biometric prompt.
   *
   * The key is stored WITHOUT requireAuthentication (see keystore.ts — the OS
   * destroys such keys when biometrics change), so this gate is enforced by us
   * rather than by the keychain. That is a weaker guarantee and worth being honest
   * about: it stops someone holding your unlocked phone, not someone running code
   * inside the app.
   */
  const reveal = useCallback(async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync().catch(() => false);
    const enrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);
    if (hasHardware && enrolled) {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: "Show your recovery phrase",
        cancelLabel: "Cancel",
      });
      if (!res.success) return;
    }
    const status = await readOwner();
    if (status.state === "present") setPhrase(status.mnemonic);
  }, []);

  const forgetEverything = useCallback(() => {
    Alert.alert(
      "Forget this device?",
      "This removes the key and grant FROM THIS PHONE ONLY. It does not stop an agent that is already running, and it does not move your funds. Without your recovery phrase written down, this is permanent.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: async () => {
            await clearGrant();
            await forgetOwner();
            router.replace("/onboarding");
          },
        },
      ],
    );
  }, []);

  const left = grant ? secondsLeft(grant) : 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}>
      {/* An explicit way out. This is a headerless modal, so the only dismissal
          was a downward swipe on iOS and the system back button on Android —
          neither of which is visible, and one of which doesn't exist on a phone
          using gesture navigation. */}
      <View style={styles.titleRow}>
        <Text style={styles.h1}>Settings</Text>
        <Pressable style={styles.done} hitSlop={10} onPress={() => router.back()}>
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>

      {/* ── the wall ─────────────────────────────────────────────────────── */}
      <Text style={styles.section}>the wall</Text>
      {!loaded ? (
        <Text style={styles.muted}>reading…</Text>
      ) : grant ? (
        <View style={[styles.card, styles.rowCard]}>
          <Row label="smart account" value={short(grant.smartAccount)} onCopy={() => Clipboard.setStringAsync(grant.smartAccount)} />
          <Row label="session key" value={short(grant.sessionKeyAddress)} />
          <Row label="owner" value={owner ? short(owner) : "—"} onCopy={owner ? () => Clipboard.setStringAsync(owner) : undefined} />
          <Row label="most per trade" value={`${grant.caps.perTradeUsdg} USDG`} />
          <Row label="most per day" value={`${grant.caps.dailyUsdg} USDG`} />
          <Row label="trades per day" value={String(grant.caps.maxOpsPerDay)} />
          <Row
            label="key expires"
            value={countdown(left)}
            tone={left <= 0 ? C.red : left < 2 * 86_400 ? C.gold : C.text}
            last
          />
          <Pressable
            style={styles.link}
            onPress={() => Linking.openURL(`${EXPLORER}/address/${grant.smartAccount}`)}
          >
            <Text style={styles.linkText}>verify every cap on the explorer →</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>
            No wall signed on this device yet. Without one, nothing can trade on your behalf.
          </Text>
          <Pressable style={styles.action} onPress={() => router.push("/onboarding/grant")}>
            <Text style={styles.actionText}>Sign a wall</Text>
          </Pressable>
        </View>
      )}

      {/* ── talking to it ────────────────────────────────────────────────── */}
      {/*
        This was its own screen. It is a setup step you do once — link the phone
        to the bot — and after that the conversation happens in Telegram, so a
        whole destination in the app for it was a tab you never went back to.

        WHY IT HANDS OFF RATHER THAN BEING A CHAT BOX. There is no chat endpoint:
        narrateChat lives in the worker, and everything that makes the
        conversation safe lives beside it — the chat allowlist, the single-use
        link code, and the confirm-park flow that stops "send 400 USDG to 0x…"
        executing on one message. A chat box here would reach none of that, or
        would need it all rebuilt, and a second implementation of a confirmation
        gate ends up subtly weaker than the first.
      */}
      <Text style={styles.section}>talking to it</Text>
      <View style={styles.card}>
        {tg === null ? (
          <Text style={styles.muted}>checking the bridge…</Text>
        ) : !tg.hasToken ? (
          /* Nothing this app can do about a missing token — the bot is created in
             Telegram and its token pasted into the dashboard, and the token
             deliberately never travels to a client. Say where to go. */
          <Text style={styles.body}>
            No bot yet. Create one with @BotFather in Telegram, then paste its token into your dashboard
            under Settings → Telegram. The token stays on the machine running your agent — it never comes to
            this phone.
          </Text>
        ) : (
          <>
            <Text style={styles.body}>
              Ask it what it&apos;s holding, why it made a trade, or tell it to stop. It answers plain
              English. Moving money out always takes a second, explicit confirmation and is capped by the
              wall you signed — one message can never send your funds anywhere.
            </Text>
            {!tg.owner && tg.linkCode && (
              <Text style={styles.muted}>
                Opening the chat sends your one-time link code, which is what tells your agent to trust this
                chat. Don&apos;t paste that code anywhere public.
              </Text>
            )}
            <Pressable style={styles.action} disabled={!tg.botUsername} onPress={openTelegram}>
              <Text style={styles.actionText}>
                {tg.owner ? "Open the conversation" : "Open Telegram and link"}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      {/* ── stopping it ──────────────────────────────────────────────────── */}
      <Text style={styles.section}>stopping your agent</Text>
      <View style={styles.card}>
        <Text style={styles.body}>
          This app holds the key that <Text style={styles.em}>creates</Text> permission. It is not the thing
          that runs your agent, so there is no button here that halts one mid-trade.
        </Text>
        <Text style={styles.body}>What actually stops it:</Text>
        <Bullet text={`The expiry already signed into the key — ${grant ? countdown(left) : "no key yet"}. It dies on schedule whether or not anyone intervenes.`} />
        <Bullet text="The kill switch in the dashboard, which reaches the worker directly because it runs beside it." />
        <Bullet text="Moving the funds out with your recovery phrase. The owner key is the only signer that can, and it is not bound by the caps." />
        {/* The one action in this list the app CAN perform, so it gets a button
            rather than being described and left to the reader to find. */}
        <Pressable style={styles.action} onPress={() => router.push("/recover")}>
          <Text style={styles.actionText}>Sweep the account to a wallet I control</Text>
        </Pressable>
      </View>

      {/* ── recovery phrase ──────────────────────────────────────────────── */}
      <Text style={styles.section}>recovery phrase</Text>
      <View style={styles.card}>
        {phrase ? (
          <>
            <View style={styles.grid}>
              {phrase.split(" ").map((w, i) => (
                <View key={`${i}-${w}`} style={styles.wordCell}>
                  <Text style={styles.wordIndex}>{i + 1}</Text>
                  <Text style={styles.word}>{w}</Text>
                </View>
              ))}
            </View>
            <Pressable style={styles.action} onPress={() => setPhrase(null)}>
              <Text style={styles.actionText}>Hide</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.body}>
              Anyone who reads these words controls your funds. Check nobody is looking over your shoulder.
            </Text>
            <Pressable style={styles.action} onPress={reveal}>
              <Text style={styles.actionText}>Show my phrase</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* ── data ─────────────────────────────────────────────────────────── */}
      <Text style={styles.section}>data</Text>
      <View style={styles.card}>
        <Row label="feed" value={isMock ? "mock (generated)" : feedOrigin} tone={isMock ? C.gold : C.text} last />
        {isMock && (
          <Text style={styles.muted}>
            Every number in this app is generated on-device. Set EXPO_PUBLIC_FEED_ORIGIN to read a real agent.
          </Text>
        )}
      </View>

      {/* ── danger ───────────────────────────────────────────────────────── */}
      <Text style={styles.section}>danger</Text>
      <Pressable style={styles.danger} onPress={forgetEverything}>
        <Text style={styles.dangerText}>Forget this device</Text>
      </Pressable>
      {/* Named for what it does. "Revoke" would imply it reaches the agent or the
          chain, and it reaches neither. */}
      <Text style={styles.dangerNote}>
        Removes the key and grant from this phone only. It does not stop a running agent and does not move your
        funds. Irreversible without your written phrase.
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  tone,
  last,
  onCopy,
}: {
  label: string;
  value: string;
  tone?: string;
  last?: boolean;
  onCopy?: () => void;
}) {
  return (
    <Pressable style={[styles.row, last && styles.rowLast]} onPress={onCopy} disabled={!onCopy}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]}>{value}</Text>
    </Pressable>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletMark}>·</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 20, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  h1: { color: C.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  done: { minHeight: 44, justifyContent: "center", paddingLeft: 12 },
  doneText: { color: C.green, fontSize: 15, fontWeight: "600" },
  section: {
    color: C.faint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.3,
    marginTop: 18,
  },
  card: { backgroundColor: C.bg2, borderRadius: 12, padding: 14, gap: 10 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 12,
    minHeight: 44,
  },
  rowLast: { borderBottomWidth: 0 },
  /**
   * For cards whose children are Rows. The rows already carry their own vertical
   * padding AND their own separator, so the card's `gap` stacked on top pushed
   * every rule 10dp toward the row above it rather than sitting between the two.
   */
  rowCard: { gap: 0 },
  rowLabel: { color: C.dim, fontSize: 13.5 },
  rowValue: { color: C.text, fontSize: 13.5, fontVariant: ["tabular-nums"] },
  body: { color: C.dim, fontSize: 13.5, lineHeight: 20 },
  em: { color: C.text2 },
  muted: { color: C.faint, fontSize: 12.5, lineHeight: 19 },
  bullet: { flexDirection: "row", gap: 8 },
  bulletMark: { color: C.green, fontSize: 14 },
  bulletText: { color: C.dim, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  link: { minHeight: 44, justifyContent: "center" },
  linkText: { color: C.green, fontSize: 13 },
  action: {
    backgroundColor: C.bg3,
    borderRadius: 12,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    // "Sweep the account to a wallet I control" already fills 80% of the button
    // at the default text size; with no horizontal padding it touches both
    // borders at iOS Larger Text and wraps flush against them above that.
    // recover.tsx solved this on its equivalent button and settings never got it.
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  actionText: { color: C.text2, fontSize: 14, fontWeight: "600", textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  wordCell: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    backgroundColor: C.bg3,
    borderRadius: 7,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minWidth: "30%",
  },
  wordIndex: { color: C.faint, fontSize: 10, fontVariant: ["tabular-nums"] },
  word: { color: C.text, fontSize: 14, fontWeight: "600" },
  danger: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(251,113,133,0.35)",
    marginTop: 4,
  },
  dangerText: { color: C.red, fontSize: 15, fontWeight: "600", textAlign: "center" },
  dangerNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
