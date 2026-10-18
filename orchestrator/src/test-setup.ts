import { afterEach } from 'vitest';
import { setRuntime } from './runtime/runtime.ts';

/**
 * Vitest loads this file before each test file. The hook clears the runtime
 * after each test, so each test sets the runtime it uses.
 */
afterEach(() => setRuntime(null));
