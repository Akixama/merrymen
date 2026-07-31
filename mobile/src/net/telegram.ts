import { isMock } from "./api";

/**
 * Telegram bridge status.
 *
 * Mirrors the GET shape of web/src/app/api/telegram/route.ts. Note what is NOT in
 * it: the bot token. That route deliberately never returns it to a client, and
 * this type exists partly to keep it that way — if a field for it ever appears
 * here, something upstream started leaking a credential.
 */
export interface TelegramStatus {
  enabled: boolean;
  connected: boolean;
  hasToken: boolean;
  botUsername: string | null;
  owner: number | null;
  allowlist: number[];
  /** Single-use code the owner sends as `/link <code>` to claim ownership. */
  linkCode: string | null;
}

const MOCK: TelegramStatus = {
  enabled: true,
  connected: true,
  hasToken: true,
  botUsername: "your_merryman_bot",
  owner: null,
  allowlist: [],
  linkCode: "7F3K-2QD9",
};

export type TelegramOutcome =
  | { ok: true; status: TelegramStatus; mock: boolean }
  | { ok: false; reason: string };

export async function fetchTelegramStatus(origin: string | null, signal?: AbortSignal): Promise<TelegramOutcome> {
  if (isMock || !origin) {
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, status: MOCK, mock: true };
  }
  try {
    const res = await fetch(`${origin}/api/telegram`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: `agent replied ${res.status}` };
    const json = (await res.json()) as Partial<TelegramStatus>;
    return {
      ok: true,
      mock: false,
      status: {
        enabled: Boolean(json.enabled),
        connected: Boolean(json.connected),
        hasToken: Boolean(json.hasToken),
        botUsername: typeof json.botUsername === "string" ? json.botUsername : null,
        owner: typeof json.owner === "number" ? json.owner : null,
        allowlist: Array.isArray(json.allowlist) ? json.allowlist : [],
        linkCode: typeof json.linkCode === "string" && json.linkCode ? json.linkCode : null,
      },
    };
  } catch {
    return { ok: false, reason: "couldn't reach your agent" };
  }
}

/**
 * The deep link that opens the conversation.
 *
 * `?start=` carries the link code into the chat as the bot's first message, so the
 * owner does not have to type `/link 7F3K-2QD9` by hand — which is where people
 * mistype and then wonder why the bot ignores them. Falls back to a plain t.me
 * link when there is no code yet.
 */
export function chatUrl(botUsername: string, linkCode: string | null): string {
  const base = `https://t.me/${botUsername.replace(/^@/, "")}`;
  return linkCode ? `${base}?start=${encodeURIComponent(linkCode)}` : base;
}
