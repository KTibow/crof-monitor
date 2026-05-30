import { readFile, writeFile } from 'node:fs/promises';

const CROF_URL = 'https://crof.ai/v1/models';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const SNAPSHOT_PATH = 'data/underpriced-embeds.json';

type CrofModel = {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    cache_prompt?: string;
  };
};

type Candidate = {
  provider: string;
  id: string;
  name: string;
  input: number;
  output: number;
  cacheRead?: number;
  source: string;
};

type Finding = {
  crof: CrofModel;
  candidate: Candidate;
};

const REQUEST_TOKENS = {
  cached: 95_000,
  input: 5_000,
  output: 1_000,
};

const money = (value: number) => `$${value.toFixed(value < 0.01 ? 6 : 3).replace(/0+$/, '').replace(/\.$/, '')}`;
const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
const priceLine = ({ input, output, cacheRead }: { input: number; output: number; cacheRead: number }) =>
  `${money(input)} input, ${money(output)} output, ${money(cacheRead)} cache read`;

const requestPrice = (input: number, output: number, cacheRead = input) =>
  ((REQUEST_TOKENS.cached * cacheRead) + (REQUEST_TOKENS.input * input) + (REQUEST_TOKENS.output * output)) / 1_000_000;

const crofPrices = (crof: CrofModel) => {
  const input = Number(crof.pricing.prompt);
  const output = Number(crof.pricing.completion);
  const cacheRead = crof.pricing.cache_prompt === undefined ? input : Number(crof.pricing.cache_prompt);
  return { input, output, cacheRead, request: requestPrice(input, output, cacheRead) };
};

const candidatePrices = (candidate: Candidate) => ({
  input: candidate.input,
  output: candidate.output,
  cacheRead: candidate.cacheRead || candidate.input,
  request: requestPrice(candidate.input, candidate.output, candidate.cacheRead || candidate.input),
});

const normalizePrice = (value: number | string | undefined, source: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return source === 'openrouter' ? parsed * 1_000_000 : parsed;
};

const comparable = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b(crof|openrouter|ai|chat|instruct|preview|latest|free)\b/g, ' ')
    .replace(/\bnormal\b/g, ' ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const aliasesFor = (model: CrofModel) => {
  const idAlias = comparable(model.id);
  const nameAlias = comparable(model.name.replace(/^.*?:\s*/, ''));
  return [...new Set([idAlias, nameAlias].filter((alias) => alias.length >= 4))].sort((a, b) => b.length - a.length);
};

const boundaryPattern = (alias: string) =>
  alias
    .split(' ')
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s:_./-]*');

const matchesModel = (crof: CrofModel, candidate: Candidate) => {
  const haystacks = [candidate.id, candidate.name].map(comparable);
  return aliasesFor(crof).some((alias) => {
    const pattern = boundaryPattern(alias);
    return haystacks.some((haystack) => new RegExp(`(?<![a-z0-9.])${pattern}$`, 'i').test(haystack));
  });
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  return response.json();
};

const openRouterCandidates = (json: { data: Array<any> }): Candidate[] =>
  json.data.flatMap((model) => {
    const input = normalizePrice(model.pricing?.prompt, 'openrouter');
    const output = normalizePrice(model.pricing?.completion, 'openrouter');
    if (input === undefined || output === undefined) return [];
    return [{
      provider: model.id.split('/')[0] ?? 'openrouter',
      id: model.id,
      name: model.name,
      input,
      output,
      cacheRead: normalizePrice(model.pricing?.input_cache_read, 'openrouter'),
      source: 'OpenRouter',
    }];
  });

const modelsDevCandidates = (json: Record<string, { models?: Record<string, any> } | Record<string, any>>): Candidate[] =>
  Object.entries(json).flatMap(([provider, providerData]) => {
    if (provider === 'crof' || provider === 'openrouter') return [];
    const models = 'models' in providerData && providerData.models ? providerData.models : providerData;
    return Object.values(models).flatMap((model: any) => {
      const input = normalizePrice(model.cost?.input, 'models.dev');
      const output = normalizePrice(model.cost?.output, 'models.dev');
      if (input === undefined || output === undefined) return [];
      return [{
        provider,
        id: model.id,
        name: model.name,
        input,
        output,
        cacheRead: normalizePrice(model.cost?.cache_read, 'models.dev'),
        source: 'models.dev',
      }];
    });
  });

const isUnderpriced = (crof: CrofModel, candidate: Candidate) => {
  const crofPrice = crofPrices(crof);
  const candidatePrice = candidatePrices(candidate);
  const requestRatio = candidatePrice.request / crofPrice.request;
  const hasDeepMetricDiscount = [
    candidatePrice.cacheRead / crofPrice.cacheRead,
    candidatePrice.input / crofPrice.input,
    candidatePrice.output / crofPrice.output,
  ].some((ratio) => ratio < 0.6);

  return requestRatio < 0.95 || (requestRatio < 1.5 && hasDeepMetricDiscount);
};

const isFreeOffering = (candidate: Candidate) =>
  candidate.input <= 0 || candidate.output <= 0 || /(?<![a-z0-9])free(?![a-z0-9])|:free/i.test(`${candidate.id} ${candidate.name}`);

const buildEmbeds = (findings: Finding[]) => {
  const grouped = Map.groupBy(findings, ({ crof }) => crof.id);
  const nicheGroups: Finding[][] = [];
  const embeds = [...grouped.values()].flatMap((group) => {
    const crof = group[0].crof;
    if (group.length === 1 && group[0].candidate.source !== 'OpenRouter') {
      nicheGroups.push(group);
      return [];
    }

    const crofPrice = crofPrices(crof);
    const cheapest = group
      .toSorted((a, b) => candidatePrices(a.candidate).request - candidatePrices(b.candidate).request)
      .slice(0, 12);
    const bestRatio = candidatePrices(cheapest[0].candidate).request / crofPrice.request;
    return {
      bestRatio,
      title: `${crof.name} underpriced elsewhere`,
      color: bestRatio < 0.5 ? 0xe74c3c : bestRatio < 0.75 ? 0xe67e22 : bestRatio < 0.95 ? 0xf1c40f : 0x9b59b6,
      fields: [
        {
          name: 'CrofAI',
          value: `${priceLine(crofPrice)}\nWeighted request: ${money(crofPrice.request)}`,
          inline: false,
        },
        ...cheapest.map(({ candidate }) => {
          const candidatePrice = candidatePrices(candidate);
          const requestRatio = candidatePrice.request / crofPrice.request;
          const metricRatios = `cache ${percent(candidatePrice.cacheRead / crofPrice.cacheRead)}, input ${percent(candidatePrice.input / crofPrice.input)}, output ${percent(candidatePrice.output / crofPrice.output)}`;
          const providerName = `${candidate.provider} via ${candidate.source}`;
          return {
            name: providerName.slice(0, 256),
            value: `${priceLine(candidatePrice)}\nWeighted request: ${money(candidatePrice.request)} (${percent(requestRatio)} of CrofAI; ${metricRatios})`.slice(0, 1024),
            inline: false,
          };
        }),
      ],
      footer: { text: 'Prices are USD per 1M tokens. Matched by normalized model id/name.' },
    };
  }).toSorted((a, b) => a.bestRatio - b.bestRatio).map(({ bestRatio, ...embed }) => embed);

  const nicheFields = nicheGroups
    .toSorted((a, b) => {
      const aRatio = candidatePrices(a[0].candidate).request / crofPrices(a[0].crof).request;
      const bRatio = candidatePrices(b[0].candidate).request / crofPrices(b[0].crof).request;
      return aRatio - bRatio;
    })
    .map(([{ crof, candidate }]) => {
      const crofPrice = crofPrices(crof);
      const candidatePrice = candidatePrices(candidate);
      const requestRatio = candidatePrice.request / crofPrice.request;
      const metricRatios = `cache ${percent(candidatePrice.cacheRead / crofPrice.cacheRead)}, input ${percent(candidatePrice.input / crofPrice.input)}, output ${percent(candidatePrice.output / crofPrice.output)}`;
      const providerName = `${candidate.provider} via ${candidate.source}`;
      return {
        name: crof.name.slice(0, 256),
        value: [
          `**CrofAI**`,
          `${priceLine(crofPrice)}`,
          `Weighted request: ${money(crofPrice.request)}`,
          '',
          `**${providerName}**`,
          `${priceLine(candidatePrice)}`,
          `Weighted request: ${money(candidatePrice.request)} (${percent(requestRatio)} of CrofAI; ${metricRatios})`,
        ].join('\n').slice(0, 1024),
        inline: false,
      };
    });

  const nicheEmbeds = [];
  for (let index = 0; index < nicheFields.length; index += 25) {
    nicheEmbeds.push({
      title: index === 0 ? 'Niche provider underpricers' : 'Niche provider underpricers continued',
      color: 0x95a5a6,
      fields: nicheFields.slice(index, index + 25),
      footer: { text: 'Single non-OpenRouter matches. Prices are USD per 1M tokens.' },
    });
  }

  return [...embeds, ...nicheEmbeds];
};

const chunkEmbeds = (embeds: Array<Record<string, unknown>>) => {
  const chunks = [];
  for (let index = 0; index < embeds.length; index += 10) chunks.push(embeds.slice(index, index + 10));
  return chunks;
};

const [crofJson, openRouterJson, modelsDevJson] = await Promise.all([
  fetchJson(CROF_URL),
  fetchJson(OPENROUTER_URL),
  fetchJson(MODELS_DEV_URL),
]);

const crofModels = crofJson.data as CrofModel[];
const candidates = [...openRouterCandidates(openRouterJson), ...modelsDevCandidates(modelsDevJson)].filter((candidate) => !isFreeOffering(candidate));
const findings = crofModels
  .flatMap((crof) => candidates
    .filter((candidate) => matchesModel(crof, candidate) && isUnderpriced(crof, candidate))
    .map((candidate) => ({ crof, candidate })))
  .toSorted((a, b) => a.crof.id.localeCompare(b.crof.id) || a.candidate.source.localeCompare(b.candidate.source));

const embeds = buildEmbeds(findings);
const snapshot = `${JSON.stringify({ embeds }, null, 2)}\n`;
const previous = await readFile(SNAPSHOT_PATH, 'utf8').catch(() => '');
const changed = snapshot !== previous;

console.log(`Matched ${findings.length} underpriced provider entries across ${embeds.length} CrofAI models.`);
console.log(snapshot);

if (changed && process.env.DRY_RUN !== '1') {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  for (const embedChunk of chunkEmbeds(embeds)) {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: embedChunk }),
    });
    if (!response.ok) throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }
}

if (changed) await writeFile(SNAPSHOT_PATH, snapshot);
console.log(changed ? `Wrote ${SNAPSHOT_PATH}.` : 'Snapshot unchanged.');
