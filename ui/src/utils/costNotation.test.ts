// Unit tests for formatModelCost — the picker's cost notation module.
// Run with: pnpm exec tsx src/utils/costNotation.test.ts
import { formatModelCost, ModelPricing } from "./costNotation";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function eq(
  cost: ModelPricing,
  wantBreakdown: string,
  wantTooltip: string | null,
  name: string,
  wantSrText: string | null = null,
) {
  const got = formatModelCost(cost);
  if (
    got.breakdown === wantBreakdown &&
    got.tooltip === wantTooltip &&
    got.srText === wantSrText
  ) {
    passed++;
  } else {
    failed++;
    failures.push(
      `✗ ${name}: got breakdown ${JSON.stringify(got.breakdown)} tooltip ${JSON.stringify(got.tooltip)} srText ${JSON.stringify(got.srText)}, want ${JSON.stringify(wantBreakdown)} / ${JSON.stringify(wantTooltip)} / ${JSON.stringify(wantSrText)}`,
    );
  }
}

// Table-driven breakdown cases.
eq(
  { input: 2, output: 10, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$2.00/$0.50/$10.00",
  null,
  "plain triple",
);

// Decimal trimming: integers render two decimals, fractional values keep at least two
// decimals, further decimals appear exactly when the real rate needs them.
const base = { output: 10, cache_read: 0.5, cache_write: 0, tiers: [] };
eq({ ...base, input: 5 }, "$5.00/$0.50/$10.00", null, "integer rate renders two decimals");
eq({ ...base, input: 0.5 }, "$0.50/$0.50/$10.00", null, "one decimal pads to two");
eq({ ...base, input: 2.5 }, "$2.50/$0.50/$10.00", null, "fractional keeps two decimals");
eq({ ...base, input: 0.075 }, "$0.075/$0.50/$10.00", null, "third decimal kept");
eq({ ...base, input: 0.0025 }, "$0.0025/$0.50/$10.00", null, "never rounds a real rate");
eq({ ...base, input: 825.24 }, "$825.24/$0.50/$10.00", null, "two decimals on a large rate");
eq({ input: 2, output: 6.25, cache_read: 0.075, cache_write: 0, tiers: [] }, "$2.00/$0.075/$6.25", null, "each slot formats independently");

// The upstream catalog carries float noise ("0.09999999999999999" for 0.1);
// rates must read as the intended decimal, not the noise.
eq(
  { input: 0.09999999999999999, output: 0.39999999999999997, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$0.10/$0.50/$0.40",
  null,
  "float noise renders as the intended decimal",
);
eq(
  { input: 0.049999999999999996, output: 1.5999999999999999, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$0.05/$0.50/$1.60",
  null,
  "float noise pads to two decimals",
);

// Margin pin for the 12-significant-digit normalize: today's longest catalog
// rate carries seven significant digits (these are real snapshot values) and
// must survive unrounded.
eq(
  { input: 0.1095892, output: 10, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$0.1095892/$0.50/$10.00",
  null,
  "a seven-significant-digit rate survives unrounded",
);

// Outside String()'s plain-decimal range ([1e-6, 1e21)) a rate would come
// out in exponent notation; a picker slot must read as a plain decimal
// ("$5e-7" tells the user nothing), whatever a future catalog refresh ships.
eq(
  { input: 5e-7, output: 10, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$0.0000005/$0.50/$10.00",
  null,
  "sub-1e-6 rate renders as a plain decimal",
);
eq(
  { input: 10, output: 1e21, cache_read: 0.5, cache_write: 0, tiers: [] },
  "$10.00/$0.50/$1000000000000000000000.00",
  null,
  "1e21-and-up rate renders as a plain decimal",
);

// Missing cache pricing dashes the cached slot so the three slots stay
// unambiguous — a missing cache discount must not read as a free one.
eq(
  { input: 2, output: 10, cache_read: 0, cache_write: 0, tiers: [] },
  "$2.00/-/$10.00",
  null,
  "missing cache pricing dashes the cached slot",
);

// A zero input or output rate is reachable (the catalog holds entries with a
// zero base rate but priced cache) and renders as $0 — the dash belongs to
// the cached slot alone.
eq(
  { input: 0, output: 0, cache_read: 0.05, cache_write: 0, tiers: [] },
  "$0.00/$0.05/$0.00",
  null,
  "zero input and output render as $0",
);

// A cache-write surcharge stars the cached slot.
eq(
  { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, tiers: [] },
  "$5.00/$0.50*/$25.00",
  "* Surcharge:\n- cache writes $6.25/M",
  "surcharge stars the cached slot",
  "cache-write surcharge — listed rates are short-context base rates",
);

// Tiered pricing prefixes the breakdown with ** — the shown rates are the
// short-context base rates, not the whole story.
eq(
  { input: 1, output: 3, cache_read: 2, cache_write: 0, tiers: [{ input: 2, output: 6, cache_read: 4, cache_write: 0, threshold_tokens: 100000 }] },
  "**$1.00/$2.00/$3.00",
  "** Tiered pricing (not reflected in conversation cumulative cost):\n- $2.00/$4.00/$6.00 @ above 100k input",
  "tiered pricing prefixes **",
  "tiered pricing applies — listed rates are short-context base rates",
);

// The PRD's combined example — both sections, tier rates tier-local, the
// tier's own surcharge starred, threshold in k:
//   * Surcharge:
//   - cache writes $1.00/M
//   ** Tiered pricing (not reflected in conversation cumulative cost):
//   - $2.00/$4.00*/$6.00 @ above 100k input
eq(
  { input: 1, output: 3, cache_read: 2, cache_write: 1, tiers: [{ input: 2, output: 6, cache_read: 4, cache_write: 2, threshold_tokens: 100000 }] },
  "**$1.00/$2.00*/$3.00",
  "* Surcharge:\n- cache writes $1.00/M\n** Tiered pricing (not reflected in conversation cumulative cost):\n- $2.00/$4.00*/$6.00 @ above 100k input",
  "combined ** prefix and surcharge star",
  "cache-write surcharge; tiered pricing applies — listed rates are short-context base rates",
);

// Tooltip: the surcharge section appears only when the surcharge marker
// does, showing the base cache-write rate.
eq(
  { input: 5, output: 25, cache_read: 0.5, cache_write: 0.125, tiers: [] },
  "$5.00/$0.50*/$25.00",
  "* Surcharge:\n- cache writes $0.125/M",
  "tooltip: surcharge section only",
  "cache-write surcharge — listed rates are short-context base rates",
);

// Tooltip: the tiered section lists each tier's own rates in the triple
// notation with its token threshold.
eq(
  { input: 1, output: 3, cache_read: 2, cache_write: 0, tiers: [{ input: 2, output: 6, cache_read: 4, cache_write: 0, threshold_tokens: 100000 }] },
  "**$1.00/$2.00/$3.00",
  "** Tiered pricing (not reflected in conversation cumulative cost):\n- $2.00/$4.00/$6.00 @ above 100k input",
  "tooltip: tiered section only",
  "tiered pricing applies — listed rates are short-context base rates",
);
eq(
  { input: 1, output: 3, cache_read: 2, cache_write: 0, tiers: [{ input: 2, output: 6, cache_read: 4, cache_write: 0, threshold_tokens: 262144 }] },
  "**$1.00/$2.00/$3.00",
  "** Tiered pricing (not reflected in conversation cumulative cost):\n- $2.00/$4.00/$6.00 @ above 262k input",
  "tooltip: threshold renders in k",
  "tiered pricing applies — listed rates are short-context base rates",
);

// Each tier renders its own line, in tier order; a tier without cache
// pricing dashes its cached slot like a base triple would.
eq(
  {
    input: 1, output: 3, cache_read: 2, cache_write: 0,
    tiers: [
      { input: 2, output: 6, cache_read: 0, cache_write: 0, threshold_tokens: 128000 },
      { input: 4, output: 12, cache_read: 8, cache_write: 0, threshold_tokens: 256000 },
    ],
  },
  "**$1.00/$2.00/$3.00",
  "** Tiered pricing (not reflected in conversation cumulative cost):\n- $2.00/-/$6.00 @ above 128k input\n- $4.00/$8.00/$12.00 @ above 256k input",
  "tooltip: one line per tier in order",
  "tiered pricing applies — listed rates are short-context base rates",
);

// The PRD's exact tooltip example, end to end.
eq(
  {
    input: 1, output: 3, cache_read: 2, cache_write: 0.125,
    tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.1, threshold_tokens: 100000 }],
  },
  "**$1.00/$2.00*/$3.00",
  "* Surcharge:\n- cache writes $0.125/M\n** Tiered pricing (not reflected in conversation cumulative cost):\n- $0.50/$0.05*/$2.50 @ above 100k input",
  "tooltip: PRD example verbatim",
  "cache-write surcharge; tiered pricing applies — listed rates are short-context base rates",
);

// The star marks the cached slot even when the slot itself is a dash (the
// catalog has such models: no cache-read pricing but a priced cache write) —
// the tooltip still explains the surcharge.
eq(
  { input: 2, output: 10, cache_read: 0, cache_write: 0.1, tiers: [] },
  "$2.00/-*/$10.00",
  "* Surcharge:\n- cache writes $0.10/M",
  "surcharge stars a dashed cached slot",
  "cache-write surcharge — listed rates are short-context base rates",
);

// A marker in the breakdown is exactly what produces a tooltip and a
// spoken form; neither appears without one.
{
  const costs: ModelPricing[] = [
    { input: 2, output: 10, cache_read: 0.5, cache_write: 0, tiers: [] },
    { input: 2, output: 10, cache_read: 0, cache_write: 0, tiers: [] },
    { input: 2, output: 10, cache_read: 0.5, cache_write: 0.1, tiers: [] },
    { input: 2, output: 10, cache_read: 0.5, cache_write: 0, tiers: [{ input: 3, output: 11, cache_read: 1, cache_write: 0, threshold_tokens: 128000 }] },
  ];
  for (const cost of costs) {
    const { breakdown, tooltip, srText } = formatModelCost(cost);
    const marked = breakdown.includes("*");
    if ((tooltip !== null) === marked && (srText !== null) === marked) passed++;
    else {
      failed++;
      failures.push(`✗ marker invariants: ${breakdown} → tooltip ${JSON.stringify(tooltip)} srText ${JSON.stringify(srText)}`);
    }
  }
}

console.log(`costNotation: ${passed} passed, ${failed} failed`);
for (const f of failures) console.error(f);
if (failed > 0) process.exit(1);
