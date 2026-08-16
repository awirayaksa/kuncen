/**
 * What Kuncen is guarding.
 *
 * Kuncen started as a lock on one DGX Spark, but nothing in the lock, the queue
 * or the timers knows or cares what is on the other side of the proxy. The name
 * is therefore a deployment parameter, not a string literal scattered through
 * the UI — point it at a build server, a licence dongle, a staging database.
 *
 * The article is separate because names differ: "the DGX Spark is free" reads
 * correctly, "the Build Server 3 is free" does not. Set
 * `KUNCEN_RESOURCE_ARTICLE=` (empty) for names that stand on their own.
 */
export interface ResourceLabel {
  /** Bare name: `DGX Spark`. */
  name: string;
  /** Mid-sentence, with its article: `the DGX Spark`. */
  the: string;
  /** Sentence-initial: `The DGX Spark`. */
  The: string;
}

export const DEFAULT_RESOURCE_NAME = 'DGX Spark';
export const DEFAULT_RESOURCE_ARTICLE = 'the';

export function resourceLabel(env: Record<string, string | undefined> = process.env): ResourceLabel {
  const name = (env.KUNCEN_RESOURCE_NAME ?? DEFAULT_RESOURCE_NAME).trim() || DEFAULT_RESOURCE_NAME;
  const article = (env.KUNCEN_RESOURCE_ARTICLE ?? DEFAULT_RESOURCE_ARTICLE).trim();
  return makeResourceLabel(name, article);
}

export function makeResourceLabel(name: string, article: string): ResourceLabel {
  if (!article) return { name, the: name, The: name };
  const capitalized = article.charAt(0).toUpperCase() + article.slice(1);
  return { name, the: `${article} ${name}`, The: `${capitalized} ${name}` };
}
