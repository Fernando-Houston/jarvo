// Skip-trace providers behind one interface (NEXT-HORIZON §1.2A/§1.3):
// trace(ownerName, mailingAddress) → phones/emails/confidence/dnc. The
// abstraction matters more than the vendor — these providers leapfrog
// yearly, so the tool layer never learns a vendor's shape.
//
// Provider resolution (first match wins):
//   SKIPTRACE_PROVIDER=mock|batchdata|enformion   explicit pick
//   SKIPTRACE_BATCHDATA_API_KEY                   → BatchData
//   SKIPTRACE_ENFORMION_AP_NAME + _AP_PASSWORD    → EnformionGO (ex-Endato)
//   (none)                                        → MOCK provider
//
// The MOCK provider exists so the whole contact engine (tool → CRM
// write-back → card → call sheet) is verifiable before a vendor account
// exists. It fabricates DETERMINISTIC test data in the reserved 555-01xx
// fictional block, labels itself loudly, and the tool layer refuses to
// write mock data to any lead except the designated test lead.
//
// ⚠️ The BatchData and Enformion clients are UNTESTED scaffolds written from
// their public docs (no key on hand) — expect to adjust field paths on the
// first real call. Both fail loud (thrown error → honest spoken answer).

export type TracedPhone = {
  number: string;
  /** "mobile" | "landline" | ... when the provider says. */
  type: string | null;
  /** Per-number confidence 0..1 when the provider scores them. */
  confidence: number | null;
  /** On the National Do-Not-Call registry (or provider's DNC flag).
   *  false also covers "provider doesn't check" — see result.dncChecked. */
  dnc: boolean;
  /** The person the provider matched this number to, when known. */
  contactName: string | null;
};

export type TraceResult = {
  provider: string;
  /** True = fabricated test data; every consumer must say so out loud. */
  mock: boolean;
  /** Overall person-match confidence 0..1 (null when provider doesn't say). */
  confidence: number | null;
  phones: TracedPhone[];
  emails: string[];
  /** Whether the provider actually screened numbers against DNC lists. */
  dncChecked: boolean;
  /** Honesty line to carry into speech/results. */
  note: string;
};

export type SkipTraceProvider = {
  name: string;
  mock: boolean;
  trace(ownerName: string, mailingAddress: string | null, siteAddress: string | null): Promise<TraceResult>;
};

/** "SMITH JOHN R" / "SMITH, JOHN" → {first, last}; entities stay whole. */
function splitOwnerName(owner: string): { first: string | null; last: string; entity: boolean } {
  const cleaned = owner.split(";")[0].trim();
  if (/\b(LLC|L L C|INC|LTD|LP|L P|CORP|TRUST|ESTATE|PARTNERS|PROPERTIES|HOMES|CHURCH|CITY OF|COUNTY)\b/i.test(cleaned)) {
    return { first: null, last: cleaned, entity: true };
  }
  const noComma = cleaned.replace(",", " ").replace(/\s+/g, " ");
  const parts = noComma.split(" ");
  // HCAD style is LAST FIRST [MIDDLE]
  if (parts.length >= 2) return { first: parts[1], last: parts[0], entity: false };
  return { first: null, last: cleaned, entity: false };
}

/** "1216 YALE ST, HOUSTON TX 77008" → parts for provider payloads. */
function splitAddress(addr: string | null): { street: string; city: string; state: string; zip: string } | null {
  if (!addr) return null;
  const zip = addr.match(/\b(\d{5})(-\d{4})?\s*$/)?.[1] ?? "";
  const [street, ...rest] = addr.split(",");
  const tail = rest.join(",").replace(/\b\d{5}(-\d{4})?\s*$/, "").trim();
  const state = tail.match(/\b([A-Z]{2})\s*$/)?.[1] ?? "TX";
  const city = tail.replace(/\b[A-Z]{2}\s*$/, "").trim() || "HOUSTON";
  return { street: street.trim(), city, state, zip };
}

// ── MOCK ──────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const mockProvider: SkipTraceProvider = {
  name: "mock",
  mock: true,
  async trace(ownerName) {
    const h = hashStr(ownerName.toUpperCase());
    // Reserved fictional block 555-01xx — can never be a real number.
    const num = (seed: number) => `(713) 555-01${String(seed % 100).padStart(2, "0")}`;
    const slug = ownerName.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 24);
    return {
      provider: "mock",
      mock: true,
      confidence: 0.87,
      phones: [
        { number: num(h), type: "mobile", confidence: 0.9, dnc: false, contactName: null },
        // Second number rides in DNC-flagged so the compliance rendering
        // (locked card row, DO-NOT-DIAL call-sheet line) stays exercised.
        { number: num(h + 37), type: "landline", confidence: 0.6, dnc: true, contactName: null },
      ],
      emails: [`${slug || "owner"}@example.com`],
      dncChecked: true,
      note: "MOCK skip-trace provider — fabricated test data, NOT real contact information. Configure a real provider to go live.",
    };
  },
};

// ── BatchData (UNTESTED scaffold — bulk + API, the standard REI choice) ──

function batchDataProvider(apiKey: string): SkipTraceProvider {
  return {
    name: "batchdata",
    mock: false,
    async trace(ownerName, mailingAddress, siteAddress) {
      const name = splitOwnerName(ownerName);
      const mail = splitAddress(mailingAddress) ?? splitAddress(siteAddress);
      if (!mail) throw new Error("skip trace needs a mailing or site address");
      const res = await fetch("https://api.batchdata.com/api/v1/property/skip-trace", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          requests: [
            {
              name: name.entity ? { full: name.last } : { first: name.first, last: name.last },
              propertyAddress: { street: mail.street, city: mail.city, state: mail.state, zip: mail.zip },
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`BatchData ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        results?: { persons?: Array<Record<string, unknown>> };
      };
      const person = data.results?.persons?.[0] as
        | {
            phoneNumbers?: Array<{ number?: string; type?: string; score?: number; dnc?: boolean; reachable?: boolean }>;
            emails?: Array<{ email?: string } | string>;
            matchScore?: number;
          }
        | undefined;
      const phones: TracedPhone[] = (person?.phoneNumbers ?? [])
        .filter((p) => p.number)
        .map((p) => ({
          number: p.number!,
          type: p.type ?? null,
          confidence: typeof p.score === "number" ? (p.score > 1 ? p.score / 100 : p.score) : null,
          dnc: Boolean(p.dnc),
          contactName: null,
        }));
      const emails = (person?.emails ?? [])
        .map((e) => (typeof e === "string" ? e : (e.email ?? "")))
        .filter(Boolean);
      return {
        provider: "batchdata",
        mock: false,
        confidence: typeof person?.matchScore === "number" ? (person.matchScore > 1 ? person.matchScore / 100 : person.matchScore) : null,
        phones,
        emails,
        dncChecked: true,
        note: "BatchData skip trace — DNC flags are the provider's screen; re-scrub any list older than 31 days before campaigns.",
      };
    },
  };
}

// ── EnformionGO / Endato — per-call Contact Enrich ($0.25/match) ──────────
// VALIDATED LIVE 2026-07-05 against a real Harris County owner: response is
// {person: {name, age, addresses[], phones[{number,type,isConnected,
// first/lastReportedDate}], emails[{email,isValidated,isBusiness}]}}, or
// {message:"No strong matches"} with no person. Misses cost nothing spoken —
// the tool reports them honestly. NOT DNC-screened (note rides along).

function enformionProvider(apName: string, apPassword: string): SkipTraceProvider {
  return {
    name: "enformion",
    mock: false,
    async trace(ownerName, mailingAddress, siteAddress) {
      const name = splitOwnerName(ownerName);
      const mail = splitAddress(mailingAddress) ?? splitAddress(siteAddress);
      const res = await fetch("https://devapi.enformion.com/Contact/Enrich", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "galaxy-ap-name": apName,
          "galaxy-ap-password": apPassword,
          "galaxy-search-type": "DevAPIContactEnrich",
        },
        body: JSON.stringify({
          FirstName: name.first ?? "",
          LastName: name.last,
          Address: mail ? { addressLine1: mail.street, addressLine2: `${mail.city}, ${mail.state} ${mail.zip}` } : undefined,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Enformion ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        isError?: boolean;
        message?: string;
        error?: { message?: string };
        person?: {
          name?: { firstName?: string; middleName?: string; lastName?: string };
          phones?: Array<{
            number?: string;
            phoneNumber?: string;
            type?: string;
            isConnected?: boolean;
            lastReportedDate?: string;
          }>;
          emails?: Array<{ email?: string; isValidated?: boolean } | string>;
        };
      };
      if (data.isError) throw new Error(`Enformion: ${data.error?.message ?? "request error"}`);
      const person = data.person;
      const matchedName = person?.name
        ? [person.name.firstName, person.name.middleName, person.name.lastName].filter(Boolean).join(" ") || null
        : null;
      // Confidence from the provider's own evidence: a connected number
      // reported within the last ~3 years is gold; connected-but-stale is a
      // coin flip; disconnected is a long shot.
      const yearsSince = (d?: string) => {
        if (!d) return null;
        const t = new Date(d).getTime();
        return Number.isFinite(t) ? (Date.now() - t) / 31557600000 : null;
      };
      const phones: TracedPhone[] = (person?.phones ?? [])
        .map((p) => ({ raw: p, number: p.number ?? p.phoneNumber ?? "" }))
        .filter((p) => p.number)
        .map((p) => {
          const age = yearsSince(p.raw.lastReportedDate);
          const confidence =
            p.raw.isConnected === false ? 0.25 : age != null && age <= 3 ? 0.85 : p.raw.isConnected ? 0.55 : 0.4;
          return {
            number: p.number,
            type: p.raw.type ?? null,
            confidence,
            dnc: false, // Enformion contact-enrich does NOT screen DNC
            contactName: matchedName,
            _age: age ?? 99,
          };
        })
        // Freshest evidence first — the top number becomes the de facto primary.
        .sort((a, b) => a._age - b._age)
        .map(({ _age, ...p }) => p);
      const emails = (person?.emails ?? [])
        .map((e) => (typeof e === "string" ? e : (e.email ?? "")))
        .filter(Boolean);
      return {
        provider: "enformion",
        mock: false,
        confidence: person ? (phones.some((p) => (p.confidence ?? 0) >= 0.85) ? 0.85 : 0.7) : null,
        phones,
        emails,
        dncChecked: false,
        note: person
          ? `matched ${matchedName ?? "a person"} at the mailing address — numbers are NOT DNC-screened; the card flags nothing until a scrub, so dial manually and honor any do-not-call ask immediately.`
          : `Enformion found no strong match for this owner (${data.message ?? "no person returned"}) — no charge on a miss beyond the request; the letter channel still works.`,
      };
    },
  };
}

/** The configured provider — always returns one (mock is the keyless floor). */
export function skipTraceProvider(): SkipTraceProvider {
  const pick = (process.env.SKIPTRACE_PROVIDER ?? "").toLowerCase();
  const batchKey = process.env.SKIPTRACE_BATCHDATA_API_KEY;
  const enfName = process.env.SKIPTRACE_ENFORMION_AP_NAME;
  const enfPass = process.env.SKIPTRACE_ENFORMION_AP_PASSWORD;
  if (pick === "mock") return mockProvider;
  if (pick === "batchdata" && batchKey) return batchDataProvider(batchKey);
  if (pick === "enformion" && enfName && enfPass) return enformionProvider(enfName, enfPass);
  if (batchKey) return batchDataProvider(batchKey);
  if (enfName && enfPass) return enformionProvider(enfName, enfPass);
  return mockProvider;
}
