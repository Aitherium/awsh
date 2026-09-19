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
  prismRuntimeDeclared,
} from '../src/bonsai-local.js';

describe('bonsai catalogue', () => {
  test('carries every size with the real blob sizes', () => {
    const byId = Object.fromEntries(BONSAI_MODELS.map((m) => [m.id, m.sizeMb]));
    // These are the measured HF blob sizes. If one of these changes, the browser catalogue
    // and check_bonsai_weight_lane.py must change with it — they are the same files.
    // Pinned by ID rather than by COUNT: the count assertion only said "four"
    // and would have had to be edited for any addition, which makes it a
    // speed bump rather than a guard. Each id carries its own measured size,
    // and a removed row now fails as a missing size instead of an off-by-one.
    assert.equal(byId['bonsai-1.7b'], 236);
    assert.equal(byId['bonsai-4b'], 545);
    assert.equal(byId['bonsai-8b'], 1104);
    assert.equal(byId['bonsai-27b'], 3627);
    assert.equal(byId['bonsai2-27b'], 5671);
  });

  test('is ordered smallest-first, so the picker offers a ladder', () => {
    const sizes = BONSAI_MODELS.map((m) => m.sizeMb);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  });

  test('every entry names a gguf the weights host actually serves', () => {
    // This asserted ONE family pattern (`Bonsai-<n>B-Q1_0.gguf`) because the
    // catalogue only held Bonsai 1. Bonsai 2 is a different family with a
    // different quantisation, so the useful invariant is not 'they all look
    // like Bonsai 1' -- it is that each file matches ITS OWN family's naming,
    // which is what the mirror serves it under. Widening this to /\.gguf$/
    // would have kept it green and stopped it catching anything.
    for (const m of BONSAI_MODELS) {
      const pattern = m.id.startsWith('bonsai2-')
        ? /^Ternary-Bonsai-2-[\d.]+B-P(TQ1|Q2)_0\.gguf$/
        : /^Bonsai-[\d.]+B-Q1_0\.gguf$/;
      assert.match(m.file, pattern);
    }
  });

  test('a fork-only model declares its runtime, and a stock one does not', () => {
    // The field that decides whether `start` refuses. If a future row forgets
    // it, that model gets served by stock llama.cpp as confident nonsense.
    for (const m of BONSAI_MODELS) {
      if (m.id.startsWith('bonsai2-')) assert.equal(m.runtime, 'prism', m.id);
      else assert.equal(m.runtime, undefined, m.id);
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

/**
 * BONSAI 2 IS A CHOICE, NOT A DEFAULT.
 *
 * It is the better model on our benchmark and it is still the wrong thing to
 * auto-select: it needs a fork the user has probably not built, and stock
 * llama.cpp does not fail on it -- it serves confident nonsense. So the rules
 * are (1) never recommend it automatically, (2) always offer it by id, and
 * (3) refuse to start it unless a prism runtime is declared.
 */
describe('choosing Bonsai 2', () => {
  test('is offered by id', () => {
    const m = findModel('bonsai2-27b');
    assert.ok(m, 'bonsai2-27b must be selectable');
    assert.equal(m.runtime, 'prism');
    assert.equal(m.sizeMb, 5671);
  });

  test('is never auto-recommended, at any RAM size', () => {
    // 256 GB would clear every ramGb threshold in the catalogue.
    for (const ram of [4, 8, 16, 32, 64, 256]) {
      assert.notEqual(recommendModel(ram).id, 'bonsai2-27b',
        `auto-recommended a fork-only model at ${ram} GB`);
      assert.equal(recommendModel(ram).runtime, undefined,
        `auto-recommended a model the stock runtime cannot serve at ${ram} GB`);
    }
  });

  test('Bonsai 1 27B survives -- a choice means both options exist', () => {
    const legacy = findModel('bonsai-27b');
    assert.ok(legacy);
    assert.equal(legacy.runtime, undefined);
    assert.equal(recommendModel(64).id, 'bonsai-27b');
  });

  test('the runtime guard asks the BINARY what it is, never the path', () => {
    // A stock build in a directory that happens to say "prism" was the exact
    // way the first path-substring version let gibberish through.
    const stock = () => 'version: 6800 (972d2313) built with GNU 14.2.0';
    const fork = () => 'version: 0.2.0-dev (build 1, commit 5d80cff) built with GNU 14.2.0';
    const broken = () => '';

    assert.equal(prismRuntimeDeclared({ LLAMA_SERVER_BIN: '/home/prism/llama.cpp/bin/llama-server' }, stock), false,
      'a stock binary under a path that says prism must NOT pass');
    assert.equal(prismRuntimeDeclared({ LLAMA_SERVER_BIN: '/usr/bin/llama-server' }, fork), true,
      'a fork binary passes wherever it lives');
    assert.equal(prismRuntimeDeclared({}, broken), false,
      'a binary that cannot answer --version is a refusal, not a pass');
    assert.equal(prismRuntimeDeclared({ AITHER_PRISM_RUNTIME: '1' }, broken), true,
      'the explicit override still wins for a rebased/renamed fork');
  });
});
