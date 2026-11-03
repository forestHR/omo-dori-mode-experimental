import { expect, test } from "bun:test";
import { cachedState } from "./state.ts";
import type { Ran, Runner } from "../../scripts/src/run.ts";

function delayedState() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Ran>();
  let now = 0;
  let collections = 0;
  const runner: Runner = async (argv) => {
    if (argv[1] === "pane" && argv[2] === "list") {
      collections++;
      started.resolve();
      return release.promise;
    }
    return { code: 0, out: '{"result":{"tabs":[]}}', err: "" };
  };
  return {
    state: cachedState(runner, () => now),
    started: started.promise,
    setTime: (ms: number) => { now = ms; },
    finish: () => release.resolve({ code: 0, out: '{"result":{"panes":[]}}', err: "" }),
    collections: () => collections,
  };
}

test("shares an in-flight read when collection outlasts the cache TTL", async () => {
  // Given: the first herdr call is still pending after 2.6 seconds.
  const fixture = delayedState();
  const first = fixture.state();
  await fixture.started;
  fixture.setTime(2600);
  // When
  const second = fixture.state();
  fixture.finish();
  await Promise.all([first, second]);
  // Then
  expect(fixture.collections()).toBe(1);
});

test("serves the completed result when a slow collection finished less than two seconds ago", async () => {
  // Given: collection began at 0 and completed at 2600.
  const fixture = delayedState();
  const first = fixture.state();
  await fixture.started;
  fixture.setTime(2600);
  fixture.finish();
  await first;
  fixture.setTime(3000);
  // When
  await fixture.state();
  // Then
  expect(fixture.collections()).toBe(1);
});

test("refreshes a slow collection's result two seconds after completion", async () => {
  // Given
  const fixture = delayedState();
  const first = fixture.state();
  await fixture.started;
  fixture.setTime(2600);
  fixture.finish();
  await first;
  fixture.setTime(4600);
  // When
  await fixture.state();
  // Then
  expect(fixture.collections()).toBe(2);
});
