import { afterEach } from 'vitest';
import { setRuntime } from './runtime/runtime.ts';

/**
 * Runs before each test file. A runtime that one test sets does not carry
 * over to the next, so each test sets the runtime it uses.
 */
afterEach(() => setRuntime(null));
