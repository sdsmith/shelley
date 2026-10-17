// Cost notation for the model picker: turns a model list cost object (the
// wire shape of server/model_costs.go's modelCostDTO, USD per million
// tokens) into the inline "$in/$cached/$out" breakdown and, when a marker
// applies, tooltip text. Every rendering surface consumes these outputs so
// notation lives in exactly one place.
//
// This is deliberately separate from tokenCostGraph's formatUsd, which is
// spend-oriented (three-to-four decimals for micro-amounts); rates need the
// notation below.

import { formatTokenCount } from "./tokenCostGraph";

/** A pricing tier's rates, USD per million tokens, applying above
 *  threshold_tokens prompt (input) tokens. */
export interface ModelPricingTier {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  threshold_tokens: number;
}

/** A model's pricing from the model list, USD per million tokens: base
 *  (short-context) rates plus any pricing tiers. */
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

// "$5", "$0.50", "$0.075" — trailing zeros trimmed (shortest form) but at
// least two decimals whenever the value is fractional, so a rate never reads
// as less precise than cents. Never rounds a real rate: extra decimals
// appear exactly when the real rate needs them.
//
// toPrecision(12) first: the upstream catalog ships float-noise literals
// ("0.09999999999999999" for 0.1), and twelve significant digits keep every
// real rate (the catalog's longest carries seven) while collapsing that
// noise back to the intended decimal.
function formatRate(v: number): string {
  const s = String(Number(v.toPrecision(12)));
  const dot = s.indexOf(".");
  if (dot < 0) return s;
  if (s.length - dot - 1 === 1) return `${s}0`;
  return s;
}

// One triple "$in/$cached/$out" shared by the base rates and each tier:
// zero cache_read prices as a dash (missing cache pricing, not free), and
// cache_write > 0 stars the cached slot (a cache-write surcharge).
function triple(r: ModelPricing | ModelPricingTier): string {
  const cached = r.cache_read === 0 ? "-" : `$${formatRate(r.cache_read)}`;
  const star = r.cache_write > 0 ? "*" : "";
  return `$${formatRate(r.input)}/${cached}${star}/$${formatRate(r.output)}`;
}

// Tooltip text sections mirror the inline markers, one section per marker,
// with detail lines beneath each header.
function tooltipLines(cost: ModelPricing): string[] {
  const lines: string[] = [];
  if (cost.cache_write > 0) {
    lines.push("* Surcharge:", `- cache writes $${formatRate(cost.cache_write)}/M`);
  }
  if (cost.tiers.length) {
    lines.push("** Tiered pricing (not reflected in conversation cumulative cost):");
    for (const tier of cost.tiers) {
      lines.push(`- ${triple(tier)} @ above ${formatTokenCount(tier.threshold_tokens)} input`);
    }
  }
  return lines;
}

export function formatModelCost(cost: ModelPricing): CostNotation {
  const lines = tooltipLines(cost);
  return { breakdown: (cost.tiers.length ? "**" : "") + triple(cost), tooltip: lines.length ? lines.join("\n") : null };
}
