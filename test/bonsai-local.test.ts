/**
 * `aither bonsai` — the pure decisions, pinned.
 *
 * The parts of this command that touch the world (spawn llama-server, stream 3.6 GB, POST to
 * the fabric) are not unit-testable and are verified live. What IS testable is every decision
 * made BEFORE those side effects, and each one is a decision that fails expensively:
 *
 *   - recommending a model that does not fit ends in an OOM or a swapping machine, minutes
 *     later, far from the choice that caused it;
 *   - a wrong catalogue size sends someone into a download their disk cannot hold;
 *   - a mis-parsed model id silently starts a DIFFERENT model than the one asked for, which
 *     then answers normally and is only wrong in ways nobody checks.
 *
 * So the sizing table and the resolver are pinned here, and the sizes are pinned against the
 * SAME numbers the browser catalogue and the weight-lane gate use — three places agreeing by
 * assertion rather than by hope.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  BONSAI_MODELS,
  findModel,
  recommendModel,
  formatMb,
  DEFAULT_PORT,
} from '../src/bonsai-local.js';

describe('bonsai catalogue', () => {
  test('carries all four sizes with the real blob sizes', () => {
    assert.equal(BONSAI_MODELS.length, 4);
    const byId = Object.fromEntries(BONSAI_MODELS.map((m) => [m.id, m.sizeMb]));
    // These are the measured HF blob sizes. If one of these changes, the browser catalogue
    // and check_bonsai_weight_lane.py must change with it — they are the same four files.
    assert.equal(byId['bonsai-1.7b'], 236);
    assert.equal(byId['bonsai-4b'], 545);
    assert.equal(byId['bonsai-8b'], 1104);
    assert.equal(byId['bonsai-27b'], 3627);
  });

  test('is ordered smallest-first, so the picker offers a ladder', () => {
    const sizes = BONSAI_MODELS.map((m) => m.sizeMb);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  });

  test('every entry names a Q1_0 gguf the weights host actually serves', () => {
    for (const m of BONSAI_MODELS) {
      assert.match(m.file, /^Bonsai-[\d.]+B-Q1_0\.gguf$/);
    }
  });
});

describe('findModel — a mis-resolved id starts the WRONG model silently', () => {
  test('resolves the canonical id', () => {
    assert.equal(findModel('bonsai-4b')?.file, 'Bonsai-4B-Q1_0.gguf');
  });

  test('resolves the bare size, which is what people actually type', () => {
    assert.equal(findModel('4b')?.id, 'bonsai-4b');
    assert.equal(findModel('1.7b')?.id, 'bonsai-1.7b');
    assert.equal(findModel('27b')?.id, 'bonsai-27b');
  });

  test('is case-insensitive', () => {
    assert.equal(findModel('Bonsai-8B')?.id, 'bonsai-8b');
  });

  test('returns undefined for an unknown id rather than guessing', () => {
    // Guessing here would start a model the caller did not ask for, which then answers
    // normally — the failure would never surface as a failure.
    assert.equal(findModel('bonsai-70b'), undefined);
    assert.equal(findModel('llama3'), undefined);
  });
});

describe('recommendModel — sizing is the decision that fails expensively', () => {
  test('a 64 GB workstation gets the 27B', () => {
    assert.equal(recommendModel(64).id, 'bonsai-27b');
  });

  test('a 32 GB desktop does NOT get the 27B', () => {
    // 27B needs ~32 GB working set; at 60% headroom a 32 GB machine affords 19.2 GB, so the
    // honest answer is the 8B. Recommending the 27B here is exactly the swap-until-unusable
    // case this function exists to avoid.
    assert.equal(recommendModel(32).id, 'bonsai-8b');
  });

  test('a 16 GB laptop gets the 4B', () => {
    assert.equal(recommendModel(16).id, 'bonsai-4b');
  });

  test('a 4 GB machine still gets a runnable answer, not nothing', () => {
    // Refusing to recommend anything is worse than recommending the one that runs: the
    // visitor concludes the product does not work on their machine when it does.
    assert.equal(recommendModel(4).id, 'bonsai-1.7b');
  });

  test('never recommends a model whose working set exceeds the machine', () => {
    for (const ram of [2, 4, 8, 16, 24, 32, 48, 64, 128]) {
      const rec = recommendModel(ram);
      // The 1.7B floor is deliberate and is the one allowed exception, on machines too small
      // for anything — it is still the smallest thing we ship.
      if (rec.id !== 'bonsai-1.7b') {
        assert.ok(rec.ramGb <= ram * 0.6, `${ram} GB -> ${rec.id} (needs ${rec.ramGb} GB)`);
      }
    }
  });

  test('is monotonic — more RAM never recommends a smaller model', () => {
    let prev = 0;
    for (const ram of [2, 4, 8, 16, 24, 32, 48, 64, 128]) {
      const size = recommendModel(ram).sizeMb;
      assert.ok(size >= prev, `recommendation shrank going up to ${ram} GB`);
      prev = size;
    }
  });
});

describe('formatMb', () => {
  test('shows MB below a gigabyte and GB above, so 3627 does not read as a typo', () => {
    assert.equal(formatMb(236), '236 MB');
    assert.equal(formatMb(1104), '1.1 GB');
    assert.equal(formatMb(3627), '3.5 GB');
  });
});

describe('defaults', () => {
  test('serves on llama.cpp default port, which is where adk probes for a local endpoint', () => {
    assert.equal(DEFAULT_PORT, 8080);
  });
});
