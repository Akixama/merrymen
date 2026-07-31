import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { feedOrigin, isMock } from "@/net/api";
import { chatUrl, fetchTelegramStatus, type TelegramStatus } from "@/net/telegram";
import { C } from "@/ui/tokens";

/**
 * Talking to your merryman.
 *
 * WHY THIS HANDS OFF TO TELEGRAM INSTEAD OF BEING A CHAT BOX. A native message
 * list would have been easy to draw and impossible to make work: there is no chat
 * endpoint. narrateChat lives in the worker, driven by the Telegram poller, and
 * everything that makes the conversation SAFE lives beside it — the chat
 * allowlist, the single-use link code that establishes ownership, and the
 * confirm-park flow that stops "send 400 USDG to 0x…" from executing on one
 * message. A chat box here would either reach none of that, or would need it all
 * rebuilt, and a second implementation of a confirmation gate is exactly the kind
 * of thing that ends up subtly weaker than the first.
 *
 * So this screen does the part it can do well: tell you whether the bridge is up,
 * hand you the link code, and open the real conversation in one tap.
 */
export default function Chat() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const origin = isMock ? null : feedOrigin;
    const out = await fetchTelegramStatus(origin);
    if (out.ok) {
      setStatus(out.status);
      setMock(out.mock);
      setError(null);
    } else {
      setError(out.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(async () => {
    if (!status?.botUsername) return;
    const url = chatUrl(status.botUsername, status.linkCode);
    const can = await Linking.canOpenURL(url).catch(() => false);
    if (!can) {
      // Telegram not installed is a normal state, not an error — the same URL
      // works in a browser, so say that rather than failing silently.
      setError("Telegram doesn't seem to be installed. The same link works in a browser.");
      return;
    }
    await Linking.openURL(url);
  }, [status]);

  const linked = Boolean(status?.owner);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Chat with your merryman</Text>
      <Text style={styles.lede}>
        Ask it what it&apos;s holding, why it made a trade, or tell it to stop. The conversation happens in
        Telegram — that&apos;s where your agent listens.
      </Text>

      {mock && (
        <View style={styles.mockBadge}>
          <Text style={styles.mockText}>
            MOCK — no agent connected, so this shows an example bot and code. Set EXPO_PUBLIC_FEED_ORIGIN to
            read a real one.
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={C.green} />
          <Text style={styles.muted}>checking the bridge…</Text>
        </View>
      ) : error ? (
        <>
          <Text style={styles.errorBox}>{error}</Text>
          <Pressable style={styles.secondary} onPress={load}>
            <Text style={styles.secondaryText}>Try again</Text>
          </Pressable>
        </>
      ) : status ? (
        <>
          <View style={styles.card}>
            <Row label="bridge" value={status.enabled ? "on" : "off"} tone={status.enabled ? C.green : C.faint} />
            <Row
              label="bot"
              value={status.botUsername ? `@${status.botUsername}` : "not set up"}
              tone={status.botUsername ? C.text : C.gold}
            />
            <Row
              label="owner linked"
              value={linked ? "yes" : "not yet"}
              tone={linked ? C.green : C.gold}
              last
            />
          </View>

          {!status.hasToken ? (
            /* Nothing this app can do about a missing token — the bot is created
               in Telegram and its token pasted into the dashboard, and the token
               deliberately never travels to a client. Say where to go. */
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No bot yet</Text>
              <Text style={styles.body}>
                Create one with @BotFather in Telegram, then paste its token into your dashboard under Settings
                → Telegram. The token stays on the machine running your agent — it never comes to this phone.
              </Text>
            </View>
          ) : (
            <>
              {!linked && status.linkCode && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Claim ownership</Text>
                  <Text style={styles.body}>
                    Your agent obeys only chats it has been told to trust. Opening the chat below sends this
                    code for you; if you&apos;d rather type it, send{" "}
                    <Text style={styles.code}>/link {status.linkCode}</Text> as your first message.
                  </Text>
                  <Pressable
                    style={styles.codeBox}
                    onPress={async () => {
                      await Clipboard.setStringAsync(status.linkCode!);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2200);
                    }}
                  >
                    <Text style={styles.codeText}>{status.linkCode}</Text>
                    <Text style={styles.codeHint}>{copied ? "copied" : "tap to copy"}</Text>
                  </Pressable>
                  <Text style={styles.muted}>
                    Single use. Anyone who has it can claim your agent, so don&apos;t paste it anywhere public.
                  </Text>
                </View>
              )}

              <Pressable style={styles.primary} disabled={!status.botUsername} onPress={open}>
                <Text style={styles.primaryText}>
                  {linked ? "Open the conversation" : "Open Telegram and link"}
                </Text>
              </Pressable>
            </>
          )}

          <Text style={styles.section}>what you can ask for</Text>
          <View style={styles.card}>
            <Ask cmd="/status" what="what it holds, and what it's worth right now" />
            <Ask cmd="/why" what="the reasoning behind its last decision, with the receipt" />
            <Ask cmd="/pause" what="stop trading, immediately" />
            <Ask cmd="plain English" what="it answers questions too — no commands required" last />
          </View>

          {/* The one thing worth knowing BEFORE you start chatting, rather than
              when a transfer prompt appears. */}
          <Text style={styles.warnText}>
            Moving money out over chat always takes a second, explicit confirmation, and is capped per transfer
            by the wall you signed. A single message can never send your funds somewhere.
          </Text>
        </>
      ) : null}

      <Pressable style={styles.ghost} onPress={() => router.back()}>
        <Text style={styles.ghostText}>back</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ label, value, tone, last }: { label: string; value: string; tone?: string; last?: boolean }) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

function Ask({ cmd, what, last }: { cmd: string; what: string; last?: boolean }) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.askCmd}>{cmd}</Text>
      <Text style={styles.askWhat}>{what}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 60, gap: 12 },
  h1: { color: C.text, fontSize: 27, fontWeight: "700", letterSpacing: -0.5 },
  lede: { color: C.dim, fontSize: 15, lineHeight: 22 },
  mockBadge: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  mockText: { color: C.gold, fontSize: 11.5, lineHeight: 17 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 },
  card: { backgroundColor: C.bg2, borderRadius: 12, padding: 14, gap: 8, marginTop: 4 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: "700" },
  body: { color: C.dim, fontSize: 13.5, lineHeight: 20 },
  code: { color: C.green },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 12,
    minHeight: 40,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: C.dim, fontSize: 13.5 },
  rowValue: { color: C.text, fontSize: 13.5 },
  askCmd: { color: C.green, fontSize: 13.5, fontWeight: "600" },
  askWhat: { color: C.dim, fontSize: 12.5, flexShrink: 1, textAlign: "right" },
  codeBox: {
    backgroundColor: C.bg3,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 4,
    minHeight: 56,
    justifyContent: "center",
  },
  codeText: { color: C.text, fontSize: 20, fontWeight: "700", letterSpacing: 2 },
  codeHint: { color: C.faint, fontSize: 11 },
  muted: { color: C.faint, fontSize: 12, lineHeight: 18 },
  section: {
    color: C.faint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.3,
    marginTop: 18,
  },
  warnText: { color: C.gold, fontSize: 12.5, lineHeight: 19, marginTop: 10 },
  errorBox: {
    color: C.red,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: "rgba(251,113,133,0.10)",
    borderColor: "rgba(251,113,133,0.30)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
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
  ghost: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 10 },
  ghostText: { color: C.faint, fontSize: 13 },
});
