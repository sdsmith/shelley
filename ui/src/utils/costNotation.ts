// Cost notation for the model picker: turns a model list cost object (the
// wire shape of server/model_costs.go's modelCostDTO, USD per million
// tokens) into the inline "$in/$cached/$out" breakdown and, when a marker
// applies, tooltip text. Rendering surfaces (task 03) consume these outputs
// so notation lives in exactly one place.
//
// This is deliberately separate from tokenCostGraph's formatUsd, which is
// spend-oriented (three-to-four decimals for micro-amounts); rates need the
// notation below.

import { formatTokenCount } from "./tokenCostGraph";

/** A pricing tier's rates, USD per million tokens. threshold_tokens is the
 *  prompt (input) token count above which the tier's rates apply. */
export interface ModelPricingTier {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  threshold_tokens: number;
}

/** A model's pricing from the model list, USD per million tokens: base
 *  (short-context) rates plus any pricing tiers — the flat wire shape of
 *  server/model_costs.go's modelCostDTO. Distinct from tokenCostGraph's
 *  ModelCost (the same four rates, no tiers) and services/api.ts's
 *  ModelCostDTO (the catalog's nested tier envelope).
 *
 *  A zero cache_read means the catalog prices no cache reads — the notation
 *  dashes the cached slot: missing, not free. A cache_write above zero is a
 *  cache-write surcharge: starred on the cached slot, detailed in the
 *  tooltip. */
export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tiers: ModelPricingTier[];
}

export interface CostNotation {
  // Inline breakdown, e.g. "**$1/$2*/$3" — ** prefixes tiered models, *
  // marks the surcharged cached slot.
  breakdown: string;
  /** Tooltip text when a marker applies, null for unmarked models. */
  tooltip: string | null;
}

// The marker glyphs, shared between the inline breakdown and the tooltip:
// each section header leads with the same marker whose inline occurrence it
// explains, and a section exists exactly when that marker appears inline.
const SURCHARGE_STAR = "*";
const TIERED_PREFIX = "**";

// "$5", "$0.50", "$0.075" — trailing zeros trimmed (shortest form) but at
// least two decimals whenever the value is fractional, so a rate never reads
// as less precise than cents. Never rounds a real rate: extra decimals
// appear exactly when the real rate needs them.
//
// toPrecision(12) first: the upstream catalog ships float-noise literals
// ("0.09999999999999999" for 0.1), and twelve significant digits collapse
// that noise back to the intended decimal. Twelve is a wide margin, not a
// rounding decision — the longest significant-digit run in today's catalog
// is seven (pinned in the tests), and a rate that long survives bit-exact.
function formatRate(v: number): string {
  let s = String(Number(v.toPrecision(12)));
  if (s.includes("e")) s = expandExponent(s);
  const dot = s.indexOf(".");
  if (dot < 0) return s;
  if (s.length - dot - 1 === 1) return `${s}0`;
  return s;
}

// "5e-7" → "0.0000005": String() switches to exponent notation outside
// [1e-6, 1e21), and a picker slot must never read "$5e-7". Restores plain
// decimals with the same digits (the 12-significant-digit normalize has
// already run).
function expandExponent(s: string): string {
  const [mantissa, exp] = s.split("e");
  const [whole, frac = ""] = mantissa.split(".");
  const digits = whole + frac;
  const point = whole.length + Number(exp);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

// A cache-write surcharge — the one rule behind both the star on a cached
// slot and the tooltip's Surcharge section, so the two can never disagree.
// The slot is starred whatever it renders: the catalog's models with no
// cache-read pricing but a priced cache write (17 today) show "$in/-*/$out",
// and the tooltip still explains the premium.
function surcharged(r: ModelPricing | ModelPricingTier): boolean {
  return r.cache_write > 0;
}

// One triple "$in/$cached/$out", shared by the base rates and each tier
// line. A zero cache_read dashes the cached slot (see ModelPricing), and
// star puts the surcharge marker on that slot.
function triple(r: ModelPricing | ModelPricingTier, star: boolean): string {
  const cached = r.cache_read === 0 ? "-" : `$${formatRate(r.cache_read)}`;
  return `$${formatRate(r.input)}/${cached}${star ? SURCHARGE_STAR : ""}/$${formatRate(r.output)}`;
}

/** Notation for one model's cost: the inline breakdown, markers included,
 *  and the tooltip text. The tooltip is "\n"-joined lines — section headers
 *  lead with their marker and end ":", detail lines start "- " — and is
 *  null exactly when the breakdown carries no marker. */
export function formatModelCost(cost: ModelPricing): CostNotation {
  const star = surcharged(cost);
  const tiered = cost.tiers.length > 0;

  const lines: string[] = [];
  if (star) {
    lines.push(`${SURCHARGE_STAR} Surcharge:`, `- cache writes $${formatRate(cost.cache_write)}/M`);
  }
  if (tiered) {
    lines.push(`${TIERED_PREFIX} Tiered pricing (not reflected in conversation cumulative cost):`);
    for (const tier of cost.tiers) {
      lines.push(`- ${triple(tier, surcharged(tier))} @ above ${formatTokenCount(tier.threshold_tokens)} input`);
    }
  }

  return {
    breakdown: (tiered ? TIERED_PREFIX : "") + triple(cost, star),
    tooltip: lines.length ? lines.join("\n") : null,
  };
}
