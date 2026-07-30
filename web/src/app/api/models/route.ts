import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";
import { llmProviderById, type MerrymenSettings } from "@merrymen/core";

export const dynamic = "force-dynamic";

interface FetchModelsBody {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

async function readSavedSettings(): Promise<MerrymenSettings> {
  try {
    return JSON.parse(
      (await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, ""),
    ) as MerrymenSettings;
  } catch {
    return {};
  }
}

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/models";
}

function filterModelId(id: string): string {
  if (/^[A-Za-z0-9._/:-]{1,128}$/.test(id)) return id;
  return "";
}

export async function POST(req: Request) {
  let body: FetchModelsBody;
  try {
    body = (await req.json()) as FetchModelsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const saved = await readSavedSettings();
  const providerId = body.provider || saved.llmProvider;
  if (!providerId) {
    return NextResponse.json({ error: "no provider specified and none saved" }, { status: 400 });
  }

  const prov = llmProviderById(providerId);
  if (!prov) {
    return NextResponse.json({ error: `unknown provider: ${providerId}` }, { status: 400 });
  }

  let apiKey = body.apiKey || "";
  if (!apiKey) {
    if (prov.id === "groq") apiKey = saved.groqApiKey ?? "";
    else if (prov.id === "anthropic") apiKey = saved.anthropicApiKey ?? "";
    else apiKey = saved.llmApiKey ?? "";
  }

  let baseUrl = prov.baseUrl;
  if (prov.id === "custom") {
    baseUrl = body.baseUrl?.trim() || saved.llmBaseUrl || "";
    if (!baseUrl) {
      return NextResponse.json({ error: "custom provider requires a base URL" }, { status: 400 });
    }
  }

  let modelsUrl: string;
  let headers: Record<string, string> = {};

  if (prov.transport === "anthropic") {
    modelsUrl = "https://api.anthropic.com/v1/models";
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (prov.id === "google") {
    modelsUrl = "https://generativelanguage.googleapis.com/v1beta/models";
    if (apiKey) {
      headers["x-goog-api-key"] = apiKey;
    }
  } else {
    modelsUrl = normalizeUrl(baseUrl);
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  try {
    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = text ? ` (${text.slice(0, 200)})` : "";
      return NextResponse.json(
        { error: `provider returned ${res.status}${detail}` },
        { status: 502 },
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    let rawModels: unknown[] = [];

    if (prov.id === "google") {
      const m = json.models;
      if (Array.isArray(m)) rawModels = m;
    } else if (prov.transport === "anthropic") {
      const d = json.data;
      if (Array.isArray(d)) rawModels = d;
    } else {
      const d = json.data;
      if (Array.isArray(d)) rawModels = d;
    }

    const models: string[] = [];
    for (const entry of rawModels) {
      if (entry && typeof entry === "object") {
        let id = "";
        if ("id" in (entry as Record<string, unknown>)) {
          id = String((entry as Record<string, unknown>).id);
        } else if ("name" in (entry as Record<string, unknown>)) {
          id = String((entry as Record<string, unknown>).name).replace(/^models\//, "");
        }
        const filtered = filterModelId(id);
        if (filtered) models.push(filtered);
      }
    }

    models.sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
