import { describe, expect, test } from 'bun:test';

import { selfMatchingProcessSearch, shellWords } from './self-match-guard';

describe('selfMatchingProcessSearch', () => {
  test('refuses the wait loops that hung three laps', () => {
    expect(selfMatchingProcessSearch('until ! pgrep -f "harness/ci.py"; do sleep 10; done')).toBe(
      'harness/ci.py'
    );
    expect(
      selfMatchingProcessSearch(
        'f=/tmp/x.output; until grep -q "ok" $f && ! pgrep -f "harness/ci.py" >/dev/null; do sleep 5; done; tail -15 $f'
      )
    ).toBe('harness/ci.py');
    expect(
      selfMatchingProcessSearch('until ! pgrep -f "odoo_runtime.py --test"; do sleep 5; done')
    ).toBe('odoo_runtime.py --test');
  });

  test('refuses combined flags, pkill and an absolute path', () => {
    expect(selfMatchingProcessSearch("while pgrep -af 'stage5.py'; do sleep 5; done")).toBe(
      'stage5.py'
    );
    expect(selfMatchingProcessSearch('pkill -9 -f odoo-bin')).toBe('odoo-bin');
    expect(selfMatchingProcessSearch('/usr/bin/pgrep --full -u soorire ci.py')).toBe('ci.py');
  });

  test('allows a bracketed pattern that cannot match its own text', () => {
    expect(
      selfMatchingProcessSearch('until ! pgrep -f "[h]arness/ci.py"; do sleep 5; done')
    ).toBeNull();
  });

  test('refuses a bracketed pattern when the same command also names the process', () => {
    expect(
      selfMatchingProcessSearch(
        'python3 harness/ci.py & until ! pgrep -f "[h]arness/ci.py"; do sleep 5; done'
      )
    ).toBe('[h]arness/ci.py');
  });

  test('allows pid waits and searches without -f', () => {
    expect(selfMatchingProcessSearch('python3 harness/ci.py & pid=$!; wait $pid')).toBeNull();
    expect(
      selfMatchingProcessSearch('timeout 480 tail --pid=$(cat out/driver.pid) -f /dev/null')
    ).toBeNull();
    expect(selfMatchingProcessSearch('pgrep postgres')).toBeNull();
    expect(selfMatchingProcessSearch('grep -f patterns.txt file')).toBeNull();
  });

  test('stops reading options at a separator', () => {
    expect(selfMatchingProcessSearch('pgrep -u me; echo -f harness')).toBeNull();
  });
});

describe('shellWords', () => {
  test('keeps quoted text together and splits on separators', () => {
    expect(shellWords(`a "b c" 'd;e';f`)).toEqual(['a', 'b c', 'd;e', ';', 'f']);
  });
});
