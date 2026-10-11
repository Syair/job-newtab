/**
 * Read every preset company's public board and count the visa rules the
 * patterns find, with the line behind one hit of each, to spot false positives.
 * Free: public ATS APIs only. `pnpm visa:smoke [slug ...]`
 */
import { PRESET_COMPANIES, atsApiUrl, visaEvidence, visaSignals, type VisaSignal } from "@job-newtab/agent-core";
import { htmlToText } from "../packages/agent-core/text";

const only = new Set(process.argv.slice(2));
const companies = PRESET_COMPANIES.filter((c) => only.size === 0 || only.has(c.slug));

/** Full description text per job, the same text the normalizers read signals from. */
function fullTexts(ats: string, data: any): Array<{ title: string; text: string }> {
  if (ats === "greenhouse") return (data.jobs ?? []).map((j: any) => ({ title: j.title, text: htmlToText(j.content ?? "") }));
  if (ats === "lever")
    return (Array.isArray(data) ? data : []).map((j: any) => ({
      title: j.text,
      text: `${j.descriptionPlain ?? ""}\n${(j.lists ?? []).map((l: any) => `${l.text}: ${htmlToText(l.content)}`).join("\n")}`,
    }));
  return (data.jobs ?? []).map((j: any) => ({ title: j.title, text: j.descriptionPlain ?? "" }));
}

for (const company of companies) {
  try {
    const res = await fetch(atsApiUrl(company));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const jobs = fullTexts(company.ats, await res.json());
    const counts: Partial<Record<VisaSignal, number>> = {};
    const examples: Partial<Record<VisaSignal, string>> = {};
    for (const job of jobs) {
      const evidence = visaEvidence(job.text);
      for (const s of visaSignals(job.text)) {
        counts[s] = (counts[s] ?? 0) + 1;
        const quote = evidence.find((e) => e.signal === s)?.quote.replace(/\s+/g, " ");
        examples[s] ??= `${job.title}: "${quote}"`;
      }
    }
    const summary = Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(", ") || "none";
    console.log(`${company.name} (${jobs.length} jobs): ${summary}`);
    for (const [s, ex] of Object.entries(examples)) console.log(`   ${s}: ${ex}`);
  } catch (err) {
    console.log(`${company.name}: ${String(err)}`);
  }
}
