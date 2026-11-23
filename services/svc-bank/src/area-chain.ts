/**
 * The one way an area of svc-bank is wired (project-state #2826).
 *
 * An area is a function in its own folder's `compose.ts`: `(root, made, options) => services`. It reads the root (what
 * every area shares, `bank-root.ts`), the services that areas listed before it made, and its own options, and returns
 * its services. `areas.ts` lists the areas in order; `BankServices` and `BankServiceOptions` are derived from that list,
 * so a new area is its own `compose.ts` and one line in `areas.ts`, and `bank-service.ts` does not change.
 *
 * The types hold the order: an area that reads a service no earlier area made does not compile, and two areas that
 * make the same service do not compile (and refuse at boot if a cast gets past the type).
 */

/** An area with its own `made` and options types erased: `add` checked them, and `compose` passes each the full set. */
type AnyArea<Root> = (root: Root, made: never, options: never) => object;

/** The keys an area would make twice; empty when it makes only new ones. */
type Clash<Services, Made> = [keyof Services & keyof Made] extends [never]
  ? []
  : [clash: `already made by an earlier area in areas.ts: ${Extract<keyof Services & keyof Made, string>}`];

export class AreaChain<Root, Made extends object, Options extends object> {
  private constructor(private readonly areas: readonly AnyArea<Root>[]) {}

  /** An empty list of areas over one root. */
  static over<Root>(): AreaChain<Root, object, object> {
    return new AreaChain<Root, object, object>([]);
  }

  /** Adds one area after the ones listed before it. It may read only what they made. */
  add<O extends object, Services extends object>(
    area: (root: Root, made: Made, options: O) => Services,
    ...clash: Clash<Services, Made>
  ): AreaChain<Root, Made & Services, Options & O> {
    void clash;
    return new AreaChain<Root, Made & Services, Options & O>([...this.areas, area]);
  }

  /** Makes every area's services, in order, each from a snapshot of what the areas before it made. */
  compose(root: Root, options: Options): Made {
    const made: Record<string, unknown> = {};
    for (const area of this.areas) {
      const services = area(root, Object.freeze({ ...made }) as never, options as never);
      for (const key of Object.keys(services)) {
        if (key in made)
          throw new Error(`svc-bank area ${area.name || '(anonymous)'} makes ${key}, which an earlier area in areas.ts made`);
      }
      Object.assign(made, services);
    }
    return made as Made;
  }
}
