import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Which providers sell the same models CrofAI sells, for less?
//
// Two tiers, because only OpenRouter publishes traffic volume:
//
//   Tier 1 — the competitor is on OpenRouter, so we know what its users
//            actually paid and can price the same traffic at CrofAI's list.
//            The finding is real annual dollars.
//   Tier 2 — the competitor is not on OpenRouter. No volume exists, so the
//            finding is a percentage gap on list prices, ranked by the
//            model's market-wide volume. Never expressed as dollars, because
//            nobody is saving them.
//
// The one rule that makes either tier meaningful: a comparison uses ONE cache
// hit rate applied to BOTH sides. Pricing CrofAI at CrofAI's hit rate and the
// competitor at theirs reports a caching-performance difference as a price
// difference, which CrofAI cannot respond to by changing prices.

const CROF_URL = "https://crof.ai/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_PROVIDERS_URL =
  "https://openrouter.ai/api/frontend/v1/all-providers";
const MODELS_DEV_URL = "https://models.dev/api.json";
const SNAPSHOT_PATH = "data/underpriced-embeds.json";

// A provider-model pair below this many non-cached tokens a week is too thin
// for its realized prices to describe a price rather than one customer. It is
// only that: a floor on whether the measurement means anything. Whether a
// measured undercut is worth reporting is TIER1_ANNUAL_FLOOR's job.
const MEANINGFUL_TOKENS_PER_WEEK = 100_000_000;
// A Tier 1 model fires when the providers undercutting CrofAI on it are worth
// at least this much a year in aggregate — a dollar a day.
const TIER1_ANNUAL_FLOOR = 365;
// A Tier 2 candidate fires on this much of a gap against CrofAI.
const TIER2_GAP_FLOOR = 0.3;
// Discord accepts ten embeds in one message. The 6000-character total is the
// constraint that actually binds, and it is enforced after the embeds are built.
const MAX_EMBEDS = 10;
const WEEKS_PER_YEAR = 52;

// Every fetch is load-bearing. A 404, a shape change, or a dropped field means
// the arithmetic below is wrong, and a wrong number posted to Discord is worse
// than a missing post. Nothing here falls back to a default.
const fetchJson = async (url: string): Promise<any> => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Fetch failed for ${url}: ${response.status} ${response.statusText}`,
    );
  return response.json();
};

const require_ = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) throw new Error(`Missing ${what}`);
  return value;
};

const finite = (value: unknown, what: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Non-numeric ${what}: ${value}`);
  return parsed;
};

const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
};

// ---------------------------------------------------------------- formatting

const priceText = (value: number) =>
  value >= 0.01 ? value.toFixed(3) : value.toFixed(4);

const triplet = (input: number, cacheRead: number, output: number) =>
  `${priceText(input)} / ${priceText(cacheRead)} / ${priceText(output)}`;

const dollars = (value: number) =>
  value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `$${(value / 1_000).toFixed(1)}K`
      : `$${value.toFixed(0)}`;

const tokens = (value: number) =>
  value >= 1e12
    ? `${(value / 1e12).toFixed(1)}T`
    : value >= 1e9
      ? `${(value / 1e9).toFixed(0)}B`
      : `${(value / 1e6).toFixed(0)}M`;

// A share that rounds to nothing is still not nothing, and printing "0%" next
// to a real number reads as a bug.
const pct = (value: number) =>
  value > 0 && value < 0.005 ? "under 1%" : `${Math.round(value * 100)}%`;

// CrofAI names models "DeepSeek: DeepSeek V4 Flash"; prose wants the tail.
const shortName = (name: string) => name.replace(/^[^:]{1,24}:\s*/, "");

// ------------------------------------------------------------ pricing basket
//
// A model's traffic is described by two numbers, both measured:
//   h — the share of input tokens served from cache
//   s — output's share of non-cached tokens
// Take one non-cached token as the unit. It splits into (1-s) uncached input
// and s output; the uncached input implies (1-s)*h/(1-h) cache reads on top.
// Costing that basket at a price triplet gives a single comparable number, and
// costing it at both CrofAI's triplet and a competitor's — with the SAME h —
// is the whole comparison.

type Mix = { cacheHitRate: number; outputShare: number };

const basket = (mix: Mix) => {
  const uncachedInput = 1 - mix.outputShare;
  return {
    uncachedInput,
    cacheReads: (uncachedInput * mix.cacheHitRate) / (1 - mix.cacheHitRate),
    output: mix.outputShare,
  };
};

const basketCost = (
  mix: Mix,
  input: number,
  cacheRead: number,
  output: number,
) => {
  const parts = basket(mix);
  return (
    parts.uncachedInput * input +
    parts.cacheReads * cacheRead +
    parts.output * output
  );
};

// --------------------------------------------------------------- CrofAI side

type CrofModel = {
  id: string;
  name: string;
  input: number;
  cacheRead: number;
  output: number;
};

const crofCatalog = (json: any): CrofModel[] => {
  const data = require_(json?.data, "crof.ai data array");
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("crof.ai returned no models");
  return data.map((model: any) => ({
    id: require_(model?.id, "crof model id"),
    name: require_(model?.name, `crof name for ${model?.id}`),
    input: finite(model?.pricing?.prompt, `crof prompt price for ${model?.id}`),
    cacheRead: finite(
      model?.pricing?.cache_prompt,
      `crof cache_prompt price for ${model?.id}`,
    ),
    output: finite(
      model?.pricing?.completion,
      `crof completion price for ${model?.id}`,
    ),
  }));
};

// ------------------------------------------------------------- model matching
//
// Matching is deliberately strict: the id as published, optionally behind an
// author or upstream-route prefix, with only variant tags stripped. Fuzzing
// names into each other is how a Gemma finetune ends up compared against
// Gemma-4-31B-it.

const VARIANT_TAG = /:(thinking|free|batch|extended|nitro|online|exacto|floor)$/;

const normalizeId = (id: string) =>
  id.toLowerCase().replace(VARIANT_TAG, "").replace(/-thinking$/, "");

const matchCrofId = (candidateId: string, crofIds: string[]) => {
  const id = normalizeId(candidateId);
  return crofIds.find(
    (crofId) =>
      id === crofId || id.endsWith(`/${crofId}`) || id.endsWith(`-${crofId}`),
  );
};

// ------------------------------------------------------- OpenRouter model map

const openRouterPermaslugs = (json: any) => {
  const data = require_(json?.data, "openrouter models data");
  const bySuffix = new Map<string, string>();
  for (const model of data) {
    const id = require_(model?.id, "openrouter model id");
    // "~author/slug" is a router alias and "slug:free" a variant; neither is a
    // model whose stats endpoints we want.
    if (id.startsWith("~") || id.includes(":")) continue;
    const suffix = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    if (!bySuffix.has(suffix))
      bySuffix.set(
        suffix,
        require_(model?.canonical_slug, `canonical_slug for ${id}`),
      );
  }
  return bySuffix;
};

// ------------------------------------------------------- OpenRouter model data

type ProviderStats = {
  name: string;
  slug: string;
  effectiveInput: number;
  effectiveOutput: number;
  cacheHitRate: number;
  nonCachedTokens: number;
};

type Endpoint = {
  tag: string;
  slug: string;
  provider: string;
  input: number;
  cacheRead: number;
  output: number;
  discount: number;
};

type ModelMarket = {
  permaslug: string;
  mix: Mix;
  weekEnding: string;
  providers: ProviderStats[];
  endpoints: Endpoint[];
  marketTotalTokens: number;
  marketInput: number;
  marketCached: number;
  marketOutput: number;
};

const fetchMarket = async (permaslug: string): Promise<ModelMarket> => {
  const query = `permaslug=${encodeURIComponent(permaslug)}`;
  const [pricingJson, activityJson, endpointsJson] = await Promise.all([
    fetchJson(
      `https://openrouter.ai/api/frontend/v1/stats/effective-pricing?${query}&shape=v7&variant=standard`,
    ),
    fetchJson(
      `https://openrouter.ai/api/frontend/v1/stats/model-activity?${query}&variant=standard`,
    ),
    fetchJson(`https://openrouter.ai/api/v1/models/${permaslug}/endpoints`),
  ]);

  const analytics = require_(
    activityJson?.data?.analytics,
    `model-activity analytics for ${permaslug}`,
  );
  // Index 0 is today and still filling; take the complete days behind it. A
  // model released this week has fewer, and the split below is a ratio, so a
  // short window still answers the only question asked of it.
  const week = analytics.slice(1, 8);
  if (week.length < 3)
    throw new Error(
      `model-activity for ${permaslug} has ${week.length} complete days`,
    );
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;
  for (const day of week) {
    // total_prompt_tokens is inclusive of cache reads; total_native_tokens_cached
    // is the cached portion of it.
    promptTokens += finite(
      day?.total_prompt_tokens,
      `total_prompt_tokens for ${permaslug}`,
    );
    cachedTokens += finite(
      day?.total_native_tokens_cached,
      `total_native_tokens_cached for ${permaslug}`,
    );
    completionTokens += finite(
      day?.total_completion_tokens,
      `total_completion_tokens for ${permaslug}`,
    );
  }
  const uncachedInput = promptTokens - cachedTokens;
  if (uncachedInput <= 0 || completionTokens <= 0)
    throw new Error(`model-activity for ${permaslug} has no billable tokens`);
  // Output's share of non-cached tokens ranges from about 2% to 30% across
  // models, so it is measured rather than assumed.
  const outputShare = completionTokens / (uncachedInput + completionTokens);
  if (!(outputShare > 0 && outputShare < 0.6))
    throw new Error(`Implausible output share for ${permaslug}: ${outputShare}`);

  const pricingData = require_(
    pricingJson?.data,
    `effective-pricing data for ${permaslug}`,
  );
  const weightedCacheHitRate = finite(
    pricingData.weightedCacheHitRate,
    `weightedCacheHitRate for ${permaslug}`,
  );
  if (!(weightedCacheHitRate >= 0 && weightedCacheHitRate < 0.99))
    throw new Error(
      `Implausible weightedCacheHitRate for ${permaslug}: ${weightedCacheHitRate}`,
    );

  const summaries = require_(
    pricingData.providerSummaries,
    `providerSummaries for ${permaslug}`,
  );
  const providers: ProviderStats[] = summaries.map((summary: any) => {
    const name = require_(summary?.providerName, `providerName for ${permaslug}`);
    const cacheHitRate = finite(
      summary?.cacheHitRate,
      `cacheHitRate for ${name} on ${permaslug}`,
    );
    if (!(cacheHitRate >= 0 && cacheHitRate < 0.995))
      throw new Error(
        `Implausible cacheHitRate for ${name} on ${permaslug}: ${cacheHitRate}`,
      );
    return {
      name,
      slug: require_(summary?.providerSlug, `providerSlug for ${name}`),
      effectiveInput: finite(
        summary?.effectiveInputPrice,
        `effectiveInputPrice for ${name} on ${permaslug}`,
      ),
      effectiveOutput: finite(
        summary?.effectiveOutputPrice,
        `effectiveOutputPrice for ${name} on ${permaslug}`,
      ),
      cacheHitRate,
      // totalTokens counts non-cached tokens only, over a fixed one-week window.
      nonCachedTokens: finite(
        summary?.totalTokens,
        `totalTokens for ${name} on ${permaslug}`,
      ),
    };
  });

  const endpointList = require_(
    endpointsJson?.data?.endpoints,
    `endpoints for ${permaslug}`,
  );
  const endpoints: Endpoint[] = endpointList.map((endpoint: any) => {
    const tag = require_(endpoint?.tag, `endpoint tag for ${permaslug}`);
    const input = finite(endpoint?.pricing?.prompt, `endpoint prompt for ${tag}`);
    const output = finite(
      endpoint?.pricing?.completion,
      `endpoint completion for ${tag}`,
    );
    // A provider that publishes no cache-read price bills cache reads at the
    // input price. That is the provider's real behaviour, and it can only ever
    // make a competitor look more expensive, never invent a saving.
    const cacheRead =
      endpoint?.pricing?.input_cache_read === undefined ||
      endpoint?.pricing?.input_cache_read === null
        ? input
        : finite(endpoint.pricing.input_cache_read, `cache read for ${tag}`);
    return {
      tag,
      // "baidu/fp8" — the leading segment is the provider slug the stats
      // endpoints use. provider_name differs between the two responses
      // ("Baidu" against "Baidu Qianfan"), so the slug is what joins them.
      slug: tag.split("/")[0],
      provider: require_(endpoint?.provider_name, `provider_name for ${tag}`),
      input: input * 1e6,
      cacheRead: cacheRead * 1e6,
      output: output * 1e6,
      discount: endpoint?.pricing?.discount
        ? finite(endpoint.pricing.discount, `discount for ${tag}`)
        : 0,
    };
  });

  const mix: Mix = { cacheHitRate: weightedCacheHitRate, outputShare };

  // Market volume is summed per provider at that provider's own hit rate, so
  // it is on the same basis as every per-provider figure in the output.
  let marketInput = 0;
  let marketCached = 0;
  let marketOutput = 0;
  for (const provider of providers) {
    const split = splitVolume(provider, outputShare);
    marketInput += split.uncachedInput;
    marketCached += split.cachedInput;
    marketOutput += split.output;
  }

  return {
    permaslug,
    mix,
    weekEnding: String(require_(week[0]?.date, "activity date")).slice(0, 10),
    providers,
    endpoints,
    marketTotalTokens: marketInput + marketCached + marketOutput,
    marketInput,
    marketCached,
    marketOutput,
  };
};

// totalTokens is non-cached only; effectiveInputPrice is blended across all
// input including cache reads. Mixing those bases understates cost by orders of
// magnitude, so gross the input back up before either price is applied.
const splitVolume = (provider: ProviderStats, outputShare: number) => {
  const uncachedInput = provider.nonCachedTokens * (1 - outputShare);
  const output = provider.nonCachedTokens * outputShare;
  const totalInput = uncachedInput / (1 - provider.cacheHitRate);
  return { uncachedInput, cachedInput: totalInput - uncachedInput, output, totalInput };
};

// ---------------------------------------------------------------- suppression

// Why a candidate that looked like a finding is not one. Reported only when
// the run is otherwise clean, ordered so the near-misses come before the
// listings that were never prices.
const SET_ASIDE_KINDS = ["thin", "route", "plan", "unpriced"] as const;
type SetAside = {
  provider: string;
  model: string;
  reason: string;
  kind: (typeof SET_ASIDE_KINDS)[number];
  gap: number;
};
const setAside: SetAside[] = [];

// A models.dev provider that lists both Anthropic and OpenAI proprietary models
// is reselling someone else's inference: no GPU host can serve either. Its
// published price is a route it bought, and models.dev records only the
// cheapest such route, so the number is not a price anyone posts. Route-level
// catalogs (llmgateway-providers) are the exception and are handled per route.
const RESELLER_NAME = /router|gateway|hub|proxy/;
const PLAN_CATALOG = /-(coding|token)-plan(-|$)/;
const PLAN_SKU_PREFIX = /^coding-/;

const isReseller = (providerId: string, modelIds: string[]) => {
  if (RESELLER_NAME.test(providerId)) return true;
  const hasClaude = modelIds.some((id) => /(^|\/)claude-/.test(id.toLowerCase()));
  const hasGpt = modelIds.some((id) =>
    /(^|\/)(gpt-\d|o\d-)/.test(id.toLowerCase()),
  );
  return hasClaude && hasGpt;
};

// ------------------------------------------------------------------ Tier 1

type Tier1Row = {
  provider: string;
  listInput: number;
  listCacheRead: number;
  listOutput: number;
  discount: number;
  nonCachedTokens: number;
  annualSaving: number;
  totalTokens: number;
};

type Tier1Finding = {
  crof: CrofModel;
  market: ModelMarket;
  rows: Tier1Row[];
  annualSaving: number;
  totalTokens: number;
  nonCachedTokens: number;
  input: number;
  cached: number;
  output: number;
};

const tier1 = (crof: CrofModel, market: ModelMarket): Tier1Finding | null => {
  const rows: Tier1Row[] = [];
  let totalTokens = 0;
  let nonCachedTokens = 0;
  let input = 0;
  let cached = 0;
  let output = 0;

  for (const provider of market.providers) {
    // Realized prices on a handful of requests describe one customer, not a
    // price. Such a pair is still compared and recorded — a threshold that
    // drops something without saying so is how the last bug survived — but it
    // cannot carry a finding.
    const thin = provider.nonCachedTokens < MEANINGFUL_TOKENS_PER_WEEK;
    const note = {
      provider: provider.name,
      model: shortName(crof.name),
    };
    // A realized price of zero on real traffic is a free tier or a data error.
    // Either way it is not a comparison, and it would post a fabricated saving.
    if (provider.effectiveInput <= 0 || provider.effectiveOutput <= 0) {
      if (!thin)
        throw new Error(
          `${provider.name} reports a zero effective price on ${market.permaslug} with ${tokens(provider.nonCachedTokens)} of traffic`,
        );
      setAside.push({
        ...note,
        reason: `reports a zero effective price, on ${tokens(provider.nonCachedTokens)} a week`,
        kind: "unpriced",
        gap: 0,
      });
      continue;
    }

    const split = splitVolume(provider, market.mix.outputShare);
    // What this traffic cost, and what the same traffic — same workload, same
    // caching behaviour — would cost at CrofAI's list price. One hit rate,
    // the provider's own, on both sides.
    const paid =
      (provider.effectiveInput * split.totalInput +
        provider.effectiveOutput * split.output) /
      1e6;
    const atCrof =
      (crof.input * split.uncachedInput +
        crof.cacheRead * split.cachedInput +
        crof.output * split.output) /
      1e6;
    if (atCrof <= paid) continue;
    if (thin) {
      setAside.push({
        ...note,
        reason: `undercuts CrofAI by ${dollars((atCrof - paid) * WEEKS_PER_YEAR)} a year, on ${tokens(provider.nonCachedTokens)} a week — under the volume floor`,
        kind: "thin",
        gap: (atCrof - paid) * WEEKS_PER_YEAR,
      });
      continue;
    }

    // A provider can list the same model at several quantizations. Output has
    // no cache blending, so the realized output price identifies which of them
    // the traffic actually ran on.
    const candidates = market.endpoints.filter(
      (candidate) => candidate.slug === provider.slug,
    );
    if (candidates.length === 0)
      throw new Error(
        `No listed endpoint for ${provider.slug} on ${market.permaslug}`,
      );
    const endpoint = candidates.reduce((best, candidate) =>
      Math.abs(candidate.output - provider.effectiveOutput) <
      Math.abs(best.output - provider.effectiveOutput)
        ? candidate
        : best,
    );

    rows.push({
      provider: provider.name,
      listInput: endpoint.input,
      listCacheRead: endpoint.cacheRead,
      listOutput: endpoint.output,
      discount: endpoint.discount,
      nonCachedTokens: provider.nonCachedTokens,
      annualSaving: (atCrof - paid) * WEEKS_PER_YEAR,
      totalTokens: split.totalInput + split.output,
    });
    totalTokens += split.totalInput + split.output;
    nonCachedTokens += provider.nonCachedTokens;
    input += split.uncachedInput;
    cached += split.cachedInput;
    output += split.output;
  }

  if (rows.length === 0) return null;
  const annualSaving = rows.reduce((sum, row) => sum + row.annualSaving, 0);
  if (annualSaving < TIER1_ANNUAL_FLOOR) {
    setAside.push({
      provider: `${rows.length} provider${rows.length === 1 ? "" : "s"}`,
      model: shortName(crof.name),
      reason: `undercut CrofAI by only ${dollars(annualSaving)} a year in total`,
      kind: "thin",
      gap: annualSaving,
    });
    return null;
  }
  rows.sort((a, b) => b.annualSaving - a.annualSaving);
  return {
    crof,
    market,
    rows,
    annualSaving,
    totalTokens,
    nonCachedTokens,
    input,
    cached,
    output,
  };
};

// ------------------------------------------------------------------ Tier 2

type Tier2Finding = {
  crof: CrofModel;
  market: ModelMarket | undefined;
  provider: string;
  route: string | undefined;
  routesBeating: number;
  routesTotal: number;
  labPrice: [number, number, number] | undefined;
  input: number;
  cacheRead: number;
  output: number;
  theirBasket: number;
  crofBasket: number;
  gap: number;
  farBelowFloor: boolean;
  peerFloor: number;
  peerFloorProvider: string | undefined;
};

const tier2Candidates = (
  modelsDev: any,
  crofModels: CrofModel[],
  markets: Map<string, ModelMarket>,
  onOpenRouter: (providerId: string) => boolean,
): Tier2Finding[] => {
  const crofIds = crofModels.map((model) => model.id);
  const findings: Tier2Finding[] = [];

  for (const [providerId, providerData] of Object.entries<any>(modelsDev)) {
    if (providerId === "crof" || providerId === "openrouter") continue;
    // llmgateway-providers is the same company as llmgateway, published one row
    // per upstream route instead of flattened to the cheapest of them. Keep the
    // routes, drop the flattened twin.
    if (providerId === "llmgateway") continue;
    const models = require_(
      providerData?.models,
      `models.dev models for ${providerId}`,
    );
    const modelIds = Object.keys(models);
    const isRouteCatalog = providerId === "llmgateway-providers";

    // Whole catalogs that are plans rather than price lists never reach the
    // ranking, and listing every one of them would bury the real set-asides.
    if (PLAN_CATALOG.test(providerId)) continue;
    const anyPriced = modelIds.some(
      (id) =>
        Number(models[id]?.cost?.input) > 0 || Number(models[id]?.cost?.output) > 0,
    );
    if (!anyPriced) continue;
    // Tier 1 already prices these providers in real dollars off real traffic.
    if (!isRouteCatalog && onOpenRouter(providerId)) continue;

    const reseller = !isRouteCatalog && isReseller(providerId, modelIds);

    for (const [modelId, model] of Object.entries<any>(models)) {
      const crofId = matchCrofId(modelId, crofIds);
      if (!crofId) continue;
      const crof = crofModels.find((candidate) => candidate.id === crofId)!;
      // Without a measured mix there is no basket to collapse two price
      // triplets into, so there is nothing to compare.
      const market = markets.get(crofId);
      if (!market) continue;

      const cost = model?.cost;
      if (!cost || cost.input === undefined || cost.output === undefined) continue;
      const input = finite(cost.input, `models.dev input for ${modelId}`);
      const output = finite(cost.output, `models.dev output for ${modelId}`);
      // No published cache-read price means cache reads bill at the input
      // price. That is the provider's real behaviour, and it can only make a
      // competitor look more expensive, never invent a saving.
      const cacheRead =
        cost.cache_read === undefined || cost.cache_read === null
          ? input
          : finite(cost.cache_read, `models.dev cache_read for ${modelId}`);

      const crofBasket = basketCost(
        market.mix,
        crof.input,
        crof.cacheRead,
        crof.output,
      );
      const theirBasket =
        input <= 0 || output <= 0
          ? 0
          : basketCost(market.mix, input, cacheRead, output);
      const gap = 1 - theirBasket / crofBasket;
      // Everything below is about what to do with an apparent undercut. A
      // candidate that does not undercut needs no explanation either way.
      if (gap < TIER2_GAP_FLOOR) continue;

      const note = { provider: providerId, model: shortName(crof.name), gap };
      const bareId = modelId.split("/").pop()!;
      if (input <= 0 || output <= 0) {
        setAside.push({
          ...note,
          reason: "listed at $0, not purchasable per token",
          kind: "unpriced",
        });
        continue;
      }
      if (PLAN_SKU_PREFIX.test(bareId)) {
        setAside.push({ ...note, reason: "plan SKU, not a metered rate", kind: "plan" });
        continue;
      }
      if (reseller) {
        // models.dev records a gateway's cheapest upstream route as the
        // gateway's own price. It is a route someone else posts, not a price
        // this company sets, and the route it came from is not published.
        setAside.push({
          ...note,
          reason: `resold route flattened to one price, ${pct(gap)} under CrofAI`,
          kind: "route",
        });
        continue;
      }

      const route = isRouteCatalog ? modelId.split("/")[0] : undefined;
      // A route that resells a provider OpenRouter also carries is already
      // priced in real dollars by Tier 1; saying it twice is not two findings.
      if (route && onOpenRouter(route)) continue;
      const siblings = isRouteCatalog
        ? modelIds.filter(
            (id) => id.includes("/") && matchCrofId(id, crofIds) === crofId,
          )
        : [];

      // One of a gateway's routes is usually the lab that trained the model.
      // Its price is the natural reference for whether a cheap route is a real
      // rate or someone burning money.
      const author = market.permaslug.split("/")[0].replace(/[^a-z0-9]/g, "");
      const labRoute = siblings.find((id) => {
        const prefix = id.split("/")[0].replace(/[^a-z0-9]/g, "");
        return (
          prefix !== route &&
          prefix.length >= 4 &&
          (prefix.startsWith(author) || author.startsWith(prefix))
        );
      });
      const labCost = labRoute ? models[labRoute].cost : undefined;
      const labPrice: [number, number, number] | undefined =
        labCost && labCost.input > 0 && labCost.output > 0
          ? [
              labCost.input,
              labCost.cache_read === undefined || labCost.cache_read === null
                ? labCost.input
                : labCost.cache_read,
              labCost.output,
            ]
          : undefined;
      const routesBeating = siblings.filter((id) => {
        const sibling = models[id].cost;
        if (!sibling || !(sibling.input > 0) || !(sibling.output > 0)) return false;
        const siblingCache =
          sibling.cache_read === undefined || sibling.cache_read === null
            ? sibling.input
            : sibling.cache_read;
        return (
          basketCost(market.mix, sibling.input, siblingCache, sibling.output) <
          crofBasket
        );
      }).length;

      // The cheapest price anyone posts on OpenRouter is the peer floor.
      // CrofAI usually sits at or below that floor, so "under half the floor"
      // — the obvious test for an unflagged promotion — would fire on almost
      // every Tier 2 finding and mean nothing. A third of the floor is where a
      // list price stops being merely competitive.
      const floors = market.endpoints
        .filter((endpoint) => endpoint.input > 0 && endpoint.output > 0)
        .map((endpoint) => ({
          provider: endpoint.provider,
          value: basketCost(
            market.mix,
            endpoint.input,
            endpoint.cacheRead,
            endpoint.output,
          ),
        }))
        .sort((a, b) => a.value - b.value);
      const peerFloor = floors[0];

      findings.push({
        crof,
        market,
        provider: route ?? providerId,
        route: route ? "LLM Gateway" : undefined,
        routesBeating,
        routesTotal: siblings.length,
        labPrice,
        input,
        cacheRead,
        output,
        theirBasket,
        crofBasket,
        gap,
        farBelowFloor: peerFloor ? theirBasket < peerFloor.value / 3 : false,
        peerFloor: peerFloor?.value ?? 0,
        peerFloorProvider: peerFloor?.provider,
      });
    }
  }

  // Rank by price gap times the model's market-wide volume: a big gap on a
  // model nobody runs is not the same finding as a big gap on a busy one.
  findings.sort(
    (a, b) =>
      b.gap * (b.market?.marketTotalTokens ?? 0) -
      a.gap * (a.market?.marketTotalTokens ?? 0),
  );
  return findings;
};

// ------------------------------------------------------------------- embeds

const RED = 0xe74c3c;
const AMBER = 0xe67e22;
const GREEN = 0x2ecc71;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

// Discord does not render tables, so columns are aligned by hand inside a code
// block. First column left, the rest right, so the numbers line up.
const alignedTable = (header: string[], rows: string[][]) => {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
      )
      .join("  ")
      .trimEnd();
  const rendered = [line(header)];
  rendered.push("-".repeat(rendered[0].length));
  for (const row of rows) rendered.push(line(row));
  return rendered;
};

const splitLine = (input: number, cached: number, output: number) => {
  const total = input + cached + output;
  return `${pct(input / total)} input, ${pct(cached / total)} cached, ${pct(output / total)} output`;
};

const tier1Embed = (finding: Tier1Finding) => {
  const { crof, market, rows } = finding;
  const name = shortName(crof.name);
  const share = finding.totalTokens / market.marketTotalTokens;
  const crofPrices = triplet(crof.input, crof.cacheRead, crof.output);
  const volume = `${tokens(finding.nonCachedTokens)} non-cached tokens a week, ${tokens(finding.totalTokens)} in total (${splitLine(finding.input, finding.cached, finding.output)}), ${pct(share)} of measured traffic on this model`;
  const footer = {
    text: `Prices per 1M tokens. Traffic from OpenRouter, week ending ${market.weekEnding}. Annualised from one week.`,
  };

  // One provider does not need a table, and a one-row code block reads as a
  // formatting accident rather than a finding.
  if (rows.length === 1) {
    const [row] = rows;
    const prose = [
      `${row.provider} posts ${triplet(row.listInput, row.listCacheRead, row.listOutput)} against CrofAI's ${crofPrices}.`,
      `On ${volume}, the gap is worth ${dollars(finding.annualSaving)} a year.`,
    ];
    if (row.discount > 0)
      prose.push(
        `${row.provider} flags that price on OpenRouter as a discount off a higher list rate.`,
      );
    return {
      title: clip(
        `${row.provider} is saving OpenRouter users ${dollars(finding.annualSaving)} a year over CrofAI on ${name}`,
        256,
      ),
      color: RED,
      description: clip(prose.join(" "), 4096),
      footer,
    };
  }

  const shown = rows.slice(0, 8);
  const rest = rows.slice(8);
  const cells = shown.map((row) => [
    clip(row.provider, 20),
    `${priceText(row.listInput)} / ${priceText(row.listOutput)}`,
    tokens(row.nonCachedTokens),
    dollars(row.annualSaving).replace("$", ""),
  ]);
  if (rest.length)
    cells.push([
      `+${rest.length} more`,
      "",
      tokens(rest.reduce((sum, row) => sum + row.nonCachedTokens, 0)),
      dollars(rest.reduce((sum, row) => sum + row.annualSaving, 0)).replace("$", ""),
    ]);
  const table = alignedTable(["provider", "in/out", "tok/wk", "saved/yr"], cells);

  const cacheReads = rows.map((row) => row.listCacheRead);
  const discounted = rows.filter((row) => row.discount > 0).length;
  const prose = [
    `${tokens(finding.totalTokens)} tokens a week (${splitLine(finding.input, finding.cached, finding.output)}), ${pct(share)} of measured traffic on this model, is on a provider cheaper than CrofAI's ${crofPrices}. Volumes below are non-cached tokens, the portion billed at full rate.`,
    `Cache reads on these providers run ${priceText(Math.min(...cacheReads))} to ${priceText(Math.max(...cacheReads))}.`,
  ];
  if (discounted)
    prose.push(
      `${discounted === rows.length ? `All ${rows.length}` : `${discounted} of the ${rows.length}`} flag their price on OpenRouter as a discount off a higher list rate.`,
    );

  return {
    title: clip(
      `${rows.length} providers on ${name} are saving OpenRouter users ${dollars(finding.annualSaving)} a year over CrofAI`,
      256,
    ),
    color: RED,
    description: clip(`${prose.join(" ")}\n\`\`\`\n${table.join("\n")}\n\`\`\``, 4096),
    footer,
  };
};

const tier2Embed = (finding: Tier2Finding) => {
  const name = shortName(finding.crof.name);
  const title = finding.route
    ? `${finding.provider} is ${pct(finding.gap)} cheaper than CrofAI on ${name}, on ${finding.routesBeating} of ${finding.routesTotal} ${finding.route} routes`
    : `${finding.provider} is ${pct(finding.gap)} cheaper than CrofAI on ${name}`;

  const prose = [
    `They post ${triplet(finding.input, finding.cacheRead, finding.output)} against CrofAI's ${triplet(finding.crof.input, finding.crof.cacheRead, finding.crof.output)}. On this model's measured traffic mix that works out to ${priceText(finding.theirBasket)} per 1M non-cached tokens against ${priceText(finding.crofBasket)}.`,
  ];
  // A price this far under what anyone else posts is what an unflagged
  // promotion looks like. Say so rather than dropping the finding: the caveat
  // carries more than a silent exclusion would. It qualifies the competitor's
  // number, so it names that number and sits directly after the sentence that
  // introduced it — the route and lab sentences below would otherwise stand
  // between the two and steal the reference.
  if (finding.farBelowFloor)
    prose.push(
      `That ${priceText(finding.theirBasket)} is under a third of the ${priceText(finding.peerFloor)} that ${finding.peerFloorProvider} posts, the cheapest for this model on OpenRouter, so treat the gap as provisional rather than a settled rate.`,
    );
  if (finding.route && finding.routesTotal > finding.routesBeating)
    prose.push(
      `The other ${finding.routesTotal - finding.routesBeating} routes on that gateway are all more expensive than CrofAI.`,
    );
  if (finding.labPrice)
    prose.push(`The lab's own route on that gateway is ${triplet(...finding.labPrice)}.`);

  const market = finding.market!;
  prose.push(
    `${finding.provider} isn't on OpenRouter, so we don't know their volume. Across all of OpenRouter, ${name} runs ${tokens(market.marketTotalTokens)} tokens a week (${splitLine(market.marketInput, market.marketCached, market.marketOutput)}).`,
  );

  return {
    title: clip(title, 256),
    color: AMBER,
    description: clip(prose.join(" "), 4096),
    footer: {
      text: `Prices per 1M tokens. Listing from models.dev, volume from OpenRouter, week ending ${market.weekEnding}.`,
    },
  };
};

const cleanEmbed = () => {
  // One line per provider and reason, however many models it covered.
  const grouped = new Map<string, SetAside & { models: string[] }>();
  for (const item of setAside) {
    const key = `${item.provider}|${item.reason}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.models.includes(item.model)) existing.models.push(item.model);
      existing.gap = Math.max(existing.gap, item.gap);
    } else grouped.set(key, { ...item, models: [item.model] });
  }
  const ordered = [...grouped.values()].sort(
    (a, b) =>
      SET_ASIDE_KINDS.indexOf(a.kind) - SET_ASIDE_KINDS.indexOf(b.kind) ||
      b.gap - a.gap,
  );
  const notes = ordered.map((item) => {
    const models =
      item.models.length <= 2
        ? item.models.join(" and ")
        : `${item.models.slice(0, 2).join(", ")} and ${item.models.length - 2} more`;
    return `${item.provider} on ${models}, ${item.reason}.`;
  });
  const shown = notes.slice(0, 6);
  if (notes.length > shown.length)
    shown.push(`And ${notes.length - shown.length} more.`);
  return {
    title: "Nothing is undercutting CrofAI",
    color: GREEN,
    description: clip(
      shown.length
        ? `Set aside: ${shown.join(" ")}`
        : "No competitor prices below CrofAI on any model it serves.",
      4096,
    ),
  };
};

// --------------------------------------------------------------------- run

const [crofJson, openRouterJson, openRouterProvidersJson, modelsDevJson] =
  await Promise.all([
    fetchJson(CROF_URL),
    fetchJson(OPENROUTER_MODELS_URL),
    fetchJson(OPENROUTER_PROVIDERS_URL),
    fetchJson(MODELS_DEV_URL),
  ]);

const crofModels = crofCatalog(crofJson);
const permaslugs = openRouterPermaslugs(openRouterJson);

const openRouterProviders = require_(
  openRouterProvidersJson?.data,
  "all-providers data",
);
const openRouterKeys = new Set<string>();
for (const provider of openRouterProviders) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  openRouterKeys.add(normalize(require_(provider?.slug, "provider slug")));
  openRouterKeys.add(normalize(require_(provider?.name, "provider name")));
}
const onOpenRouter = (providerId: string) => {
  const key = providerId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    openRouterKeys.has(key) ||
    openRouterKeys.has(key.replace(/ai$/, "")) ||
    openRouterKeys.has(key.replace(/cloud$/, ""))
  );
};

const matched = crofModels.flatMap((model) => {
  const permaslug = permaslugs.get(model.id);
  return permaslug ? [{ model, permaslug }] : [];
});
const unmatched = crofModels.filter((model) => !permaslugs.has(model.id));

const marketList = await mapLimit(matched, 6, async ({ model, permaslug }) => ({
  id: model.id,
  market: await fetchMarket(permaslug),
}));
const markets = new Map(marketList.map((entry) => [entry.id, entry.market]));

const tier1Findings = matched
  .flatMap(({ model }) => {
    const finding = tier1(model, markets.get(model.id)!);
    return finding ? [finding] : [];
  })
  .sort((a, b) => b.annualSaving - a.annualSaving);

const tier2Findings = tier2Candidates(
  modelsDevJson,
  crofModels,
  markets,
  onOpenRouter,
);

// Tier 1 first: real dollars outrank a percentage on unmeasured traffic.
const embeds = [
  ...tier1Findings.map(tier1Embed),
  ...tier2Findings.map(tier2Embed),
].slice(0, MAX_EMBEDS);
if (embeds.length === 0) embeds.push(cleanEmbed());

// Discord rejects a payload whose embeds total over 6000 characters. Drop from
// the bottom, which is the least valuable end, rather than posting nothing.
const embedSize = (embed: (typeof embeds)[number]) =>
  JSON.stringify(embed).length;
if (embedSize(embeds[0]) > 6000)
  throw new Error("Leading embed alone exceeds Discord's 6000 character limit");
while (embeds.reduce((sum, embed) => sum + embedSize(embed), 0) > 6000)
  embeds.pop();

const pairs = matched.reduce(
  (sum, { model }) =>
    sum +
    markets
      .get(model.id)!
      .providers.filter(
        (provider) => provider.nonCachedTokens >= MEANINGFUL_TOKENS_PER_WEEK,
      ).length,
  0,
);
console.error(
  [
    `CrofAI catalog: ${crofModels.length} models, ${matched.length} on OpenRouter` +
      (unmatched.length ? ` (no OpenRouter listing: ${unmatched.map((m) => m.id).join(", ")})` : ""),
    `Provider-model pairs with meaningful volume: ${pairs}`,
    `Tier 1 findings: ${tier1Findings.length} (${tier1Findings.reduce((sum, f) => sum + f.rows.length, 0)} providers)`,
    `Tier 2 findings: ${tier2Findings.length}`,
    `Set aside: ${setAside.length}`,
    ...setAside.map((item) => `  - ${item.provider} on ${item.model}, ${item.reason}`),
  ].join("\n"),
);

const snapshot = `${JSON.stringify({ embeds }, null, 2)}\n`;
const previous = await readFile(SNAPSHOT_PATH, "utf8").catch(() => "");
const changed = snapshot !== previous;
console.log(snapshot);

if (changed && process.env.DRY_RUN !== "1") {
  const webhook = require_(
    process.env.DISCORD_WEBHOOK_URL,
    "DISCORD_WEBHOOK_URL",
  );
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds }),
  });
  if (!response.ok)
    throw new Error(
      `Discord webhook failed: ${response.status} ${response.statusText} ${await response.text()}`,
    );
}

if (changed) {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, snapshot);
}
console.error(changed ? `Wrote ${SNAPSHOT_PATH}.` : "Snapshot unchanged.");
