/**
 * Refuses a shell command that searches running processes with `pgrep -f` or
 * `pkill -f` for a pattern the command itself contains (LWOS; Director decision
 * 2026-10-17). The shell that runs the command carries that pattern on its own
 * command line, so `until ! pgrep -f "harness/ci.py"; do sleep 5; done` matches
 * the waiting shell and never ends, and `pkill -f` would end that shell. Three
 * factory laps lost thirty minutes each to the wait.
 */

const SEPARATORS = new Set([';', '|', '&', '(', ')', '\n']);
// Short options of pgrep and pkill that take a value in the next word.
const VALUE_OPTIONS = new Set(['u', 'U', 'g', 'G', 'P', 's', 't', 'F']);
const LONG_VALUE_OPTIONS = new Set([
  '--euid',
  '--uid',
  '--pgroup',
  '--group',
  '--parent',
  '--session',
  '--terminal',
  '--pidfile',
  '--signal',
  '--ns',
  '--nslist',
  '--older',
  '--runstates',
  '--cgroup',
  '--env',
]);

/** Split a command into shell words and separators, honouring quotes and backslashes. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === '\\' && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (SEPARATORS.has(char)) {
      if (inWord) words.push(current);
      words.push(char);
      current = '';
      inWord = false;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

function matchesItself(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command);
  } catch {
    return command.includes(pattern);
  }
}

/**
 * The pattern of the first `pgrep -f` or `pkill -f` in `command` that matches the
 * command's own text, or null when there is none.
 */
export function selfMatchingProcessSearch(command: string): string | null {
  const words = shellWords(command);
  for (let i = 0; i < words.length; i++) {
    const name = words[i].split('/').pop();
    if (name !== 'pgrep' && name !== 'pkill') continue;
    let full = false;
    let pattern: string | undefined;
    for (let j = i + 1; j < words.length && !SEPARATORS.has(words[j]); j++) {
      const word = words[j];
      if (word === '--') {
        pattern = words[j + 1];
        break;
      }
      if (word.startsWith('--')) {
        if (word === '--full') full = true;
        if (LONG_VALUE_OPTIONS.has(word)) j++;
        continue;
      }
      if (word.startsWith('-') && word.length > 1) {
        const flags = word.slice(1);
        if (/^\d+$/.test(flags)) continue; // pkill -9
        for (let k = 0; k < flags.length; k++) {
          if (flags[k] === 'f') full = true;
          if (VALUE_OPTIONS.has(flags[k])) {
            if (k === flags.length - 1) j++;
            break;
          }
        }
        continue;
      }
      pattern = word;
      break;
    }
    if (full && pattern && matchesItself(pattern, command)) return pattern;
  }
  return null;
}

/** The reason given to the agent when its command is refused. */
export function selfMatchRefusal(pattern: string): string {
  return (
    `Refused: this command searches processes with -f for "${pattern}", which also matches ` +
    'the shell running this command, so a wait on it never ends (AGENTS.md, Harness and runtime). ' +
    'Wait on the pid instead: start the command with & and use wait $!, ' +
    'or tail --pid=<pid> -f /dev/null with the pid from $! or a pid file.'
  );
}
