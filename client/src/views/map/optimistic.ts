/**
 * Optimistic writes for the World Map (P2.6.5): the click flips immediately, and the
 * state returns to exactly what it was if the write does not land.
 *
 * ── WHY A SNAPSHOT AND NOT AN INVERSE OPERATION ───────────────────────────────────────
 * Rolling back by applying the opposite change is only correct when the change was
 * invertible from what the caller happens to remember. A confirmed move deletes one
 * membership row and inserts another; "delete the new row" would leave the country
 * INDEPENDENT rather than back with its old owner — a state the author never asked for
 * and would have to notice to undo. Restoring the value the state had before the click is
 * the only formulation that is right for every write here, including the ones that touch
 * two collections (deleting a grouping) or none of the obvious ones (a rename).
 *
 * ── WHY THE WRITES ARE SERIALIZED ─────────────────────────────────────────────────────
 * A snapshot rollback is only sound if nothing else moved the state in between. Two
 * clicks in flight at once and the second one's rollback would discard the first one's
 * success. `createWriteQueue` chains them, which also gives the 409's confirmation prompt
 * — a modal that blocks — the exclusivity it already implies.
 *
 * ── WHY A DECLINE IS NOT AN ERROR ─────────────────────────────────────────────────────
 * The "Move from ⟨X⟩?" prompt (P2.3.3) is answerable with No, and No is a normal outcome:
 * the state rolls back and nothing is reported, because nothing went wrong. That is a
 * different path from a failed write, which rolls back AND says why — so it is a distinct
 * signal (`Declined`) rather than an error string the caller has to pattern-match on.
 */

/** A change to apply to the held state. Pure: it returns the next value. */
export type Reconcile<T> = (previous: T) => T;

/** The container's state, behind the two operations an optimistic write needs. */
export type OptimisticStore<T> = {
  /** MUST return the value as of now — a stale read makes the snapshot wrong. */
  read: () => T;
  write: (next: T) => void;
};

/**
 * What a write did.
 *
 * `'declined'` is separated from `'failed'` so the caller can stay silent for the one and
 * report the other; both have already rolled the state back by the time they are returned.
 */
export type WriteOutcome = 'applied' | 'declined' | 'failed';

/**
 * Thrown by a `send` whose author answered No to a confirmation.
 *
 * It carries no message anyone reads: it is a control signal, and the reason it is an
 * exception rather than a return value is that it has to unwind from inside whatever
 * nesting the send used to ask the question.
 */
export class Declined extends Error {
  constructor() {
    super('the author declined the write');
    this.name = 'Declined';
  }
}

/**
 * Apply `apply` immediately, then run `send`; restore the snapshot if `send` throws.
 *
 * `send` may return a second `Reconcile` — the reconciliation with what the server
 * actually wrote. That is not ceremony: `PUT /:id/countries/:countryId` answers with the
 * `grouping_country` row, and re-confirming an existing membership returns it with its
 * `isLeader` intact, which the optimistic row (always `isLeader: false`) would otherwise
 * quietly clear.
 *
 * The reconciliation is applied to the state as it is AFTER the send, not to the
 * snapshot: a later write may have been queued behind this one, and rebuilding from the
 * snapshot would undo it.
 */
export async function runOptimistic<T>(
  store: OptimisticStore<T>,
  apply: Reconcile<T>,
  send: () => Promise<Reconcile<T> | void>,
  onFailure: (error: unknown) => void,
): Promise<WriteOutcome> {
  const snapshot = store.read();
  store.write(apply(snapshot));

  let reconcile: Reconcile<T> | void;
  try {
    reconcile = await send();
  } catch (error) {
    store.write(snapshot);
    if (error instanceof Declined) return 'declined';
    onFailure(error);
    return 'failed';
  }

  if (typeof reconcile === 'function') store.write(reconcile(store.read()));
  return 'applied';
}

/**
 * A queue that runs one job at a time, in the order they were submitted.
 *
 * Each job is chained onto the previous one's SETTLEMENT, not its success — a write that
 * failed has already rolled back, and the next click must still run.
 */
export function createWriteQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return <T,>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    // The queue's own tail must never reject, or every job after a failure would be
    // chained onto a rejected promise and reported as failing for someone else's reason.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
