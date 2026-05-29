/**
 * Optional local embedder for SparseTreeGrep semantic recall.
 *
 * Wraps `@xenova/transformers` (ONNX Runtime in Node, no native deps) to
 * compute dense vectors for chunks and queries. The dep is **NOT** declared
 * in package.json — it's dynamic-imported so the AXIOM install stays slim
 * for users who don't want a 40-100MB model + onnxruntime in their tree.
 *
 * Opt-in path:
 *
 *     npm i @xenova/transformers
 *
 * After install, the next AXIOM run that hits {@link getEmbedder} will lazily
 * load the configured model. First call downloads + caches the model into
 * `~/.cache/huggingface/`. Subsequent runs reuse the cached weights.
 *
 * If `@xenova/transformers` is not installed, every getEmbedder() call
 * resolves to `undefined` and SparseTreeGrep falls back to pure TF-IDF — no
 * crash, no error log.
 *
 * Model defaults to `Xenova/bge-small-en-v1.5` (384-dim, ~33MB quantized,
 * best precision-per-MB in the BGE family). Override via env:
 *
 *     AXIOM_EMBED_MODEL=Xenova/all-MiniLM-L6-v2 axiom ...
 */

export interface Embedder {
	readonly modelId: string;
	readonly dim: number;
	embed(texts: string[]): Promise<Float32Array[]>;
}

let cachedEmbedder: Embedder | undefined;
let loadAttempted = false;
let loadFailed = false;

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * Lazily resolve an embedder. Returns undefined when the optional dep is
 * missing or when model load failed (e.g. offline first-run with no cached
 * weights). Subsequent failed attempts short-circuit immediately so we never
 * stall on a broken setup.
 */
export async function getEmbedder(): Promise<Embedder | undefined> {
	if (cachedEmbedder) return cachedEmbedder;
	if (loadFailed) return undefined;
	if (loadAttempted) return cachedEmbedder;
	loadAttempted = true;
	try {
		// Dynamic import: package may not be installed. The unusual `Function`
		// indirection prevents bundlers / tsc from trying to resolve the
		// module at build time — purely a runtime opt-in.
		const dynImport = new Function("specifier", "return import(specifier)") as (
			specifier: string,
		) => Promise<unknown>;
		const lib = (await dynImport("@xenova/transformers")) as {
			pipeline: (task: string, model: string, opts?: unknown) => Promise<XenovaPipeline>;
			env?: { allowLocalModels?: boolean; cacheDir?: string };
		};
		const modelId = process.env.AXIOM_EMBED_MODEL ?? DEFAULT_MODEL;
		const pipe = await lib.pipeline("feature-extraction", modelId, { quantized: true });
		// Probe dim with a one-shot run so consumers can size their stores.
		const probe = (await pipe(["axiom embedder probe"], { pooling: "mean", normalize: true })) as XenovaTensor;
		const dim = probe.dims[probe.dims.length - 1] ?? 384;
		cachedEmbedder = {
			modelId,
			dim,
			async embed(texts: string[]): Promise<Float32Array[]> {
				if (texts.length === 0) return [];
				const out = (await pipe(texts, { pooling: "mean", normalize: true })) as XenovaTensor;
				// Tensor.data is a flat Float32Array of length (batch * dim).
				const flat = out.data;
				const vectors: Float32Array[] = [];
				for (let i = 0; i < texts.length; i++) {
					vectors.push(flat.slice(i * dim, (i + 1) * dim));
				}
				return vectors;
			},
		};
		return cachedEmbedder;
	} catch {
		// Module missing, weights unavailable, runtime error — all degrade
		// to the no-embedder path. SparseTreeGrep still works on TF-IDF.
		loadFailed = true;
		return undefined;
	}
}

/**
 * Cosine similarity between two unit-normalized vectors. The embedder
 * normalizes outputs, so this collapses to a dot product. Returns NaN-safe 0
 * for length mismatch (defensive only — shouldn't happen in practice).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

// Minimal structural typings for the dynamic import. We deliberately do not
// `import type` from `@xenova/transformers` so consumers without the dep
// installed don't trip the TypeScript resolver.
interface XenovaTensor {
	data: Float32Array;
	dims: number[];
}

type XenovaPipeline = (
	input: string[],
	opts?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<XenovaTensor>;
