/**
 * Every upstream request this process currently holds open.
 *
 * When the drain ceiling expires we close the connection to vLLM, not just the
 * one to the client. Dropping only the client socket would leave the GPU
 * generating tokens nobody will ever read — on time that now belongs to the
 * *next* holder, who would get "exclusive" access to a box secretly still
 * working on the last person's prompt.
 */
export class InFlightRegistry {
  private controllers = new Set<AbortController>();

  add(controller: AbortController): () => void {
    this.controllers.add(controller);
    return () => {
      this.controllers.delete(controller);
    };
  }

  get size(): number {
    return this.controllers.size;
  }

  killAll(reason: string): number {
    const n = this.controllers.size;
    for (const controller of this.controllers) {
      try {
        controller.abort(new KuncenAbort(reason));
      } catch {
        // an already-aborted controller is exactly the outcome we wanted
      }
    }
    this.controllers.clear();
    return n;
  }
}

export class KuncenAbort extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'KuncenAbort';
  }
}
